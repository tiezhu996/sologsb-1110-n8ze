import { defineStore } from 'pinia';
import { db, getMeta, setMeta } from '../utils/db';
import { uid } from '../utils/id';
import { toPlain } from '../utils/plain';
import { recalcTotals } from '../utils/recalc';
import { useLacquerStore } from './lacquerStore';
import type { OutsourcedReceipt, ReceiptStatus } from '../types/outsourced';

/** 回执登记入参（地方批号与本坊琴号分开记录） */
export interface ReceiptInput {
  receiptNo: string;
  batchNo: string;
  guqinNo: string;
  seq: number;
  layerThickness: number;
  mixRatio: string;
  appliedAt: string;
  workshop: string;
  status?: ReceiptStatus;
  remark?: string;
}

/** 待核销队列中的一条回执（写入失败前先持久化，保留已核销位置） */
export interface QueuedReceipt extends ReceiptInput {
  queuedAt: string;
}

/** 核销游标：记录队列处理到第几条、失败原因；用于失败后重试 */
export interface IngestCursor {
  /** 已成功核销条数（重试从该位置继续） */
  position: number;
  /** 最近一次失败信息 */
  error?: string;
  /** 最近一次尝试时间 ISO */
  attemptedAt?: string;
  /** 队列总条数 */
  total: number;
  /** 去重跳过的回执单号 */
  skipped: string[];
}

const QUEUE_META_KEY = 'receipt-ingest-queue';
const CURSOR_META_KEY = 'receipt-ingest-cursor';

interface ReceiptState {
  receipts: OutsourcedReceipt[];
  queue: QueuedReceipt[];
  cursor: IngestCursor | null;
  hydrated: boolean;
}

async function loadQueue(): Promise<QueuedReceipt[]> {
  const raw = await getMeta(QUEUE_META_KEY);
  return raw ? (JSON.parse(raw) as QueuedReceipt[]) : [];
}

async function saveQueue(queue: QueuedReceipt[]): Promise<void> {
  await setMeta(QUEUE_META_KEY, JSON.stringify(queue));
}

async function loadCursor(): Promise<IngestCursor | null> {
  const raw = await getMeta(CURSOR_META_KEY);
  return raw ? (JSON.parse(raw) as IngestCursor | null) : null;
}

async function saveCursor(cursor: IngestCursor | null): Promise<void> {
  if (cursor) await setMeta(CURSOR_META_KEY, JSON.stringify(cursor));
  else await db.meta.delete(CURSOR_META_KEY);
}

/** 外协漆坊施工回执：登记、核销入队、重试、中途退出 */
export const useReceiptStore = defineStore('receipt', {
  state: (): ReceiptState => ({ receipts: [], queue: [], cursor: null, hydrated: false }),

  getters: {
    receiptsOf(state) {
      return (guqinNo: string): OutsourcedReceipt[] =>
        state.receipts.filter((r) => r.guqinNo === guqinNo).sort((a, b) => a.seq - b.seq);
    },
    byReceiptNo(state) {
      return (receiptNo: string): OutsourcedReceipt | undefined => state.receipts.find((r) => r.receiptNo === receiptNo);
    },
    guqinNos(state): string[] {
      return Array.from(new Set(state.receipts.map((r) => r.guqinNo))).sort();
    },
    /** 待核销（含重试）条数 */
    pendingCount(state): number {
      return state.cursor ? state.queue.length - state.cursor.position : 0;
    },
    /** 中途退出的回执数 */
    withdrawnCount(state): number {
      return state.receipts.filter((r) => r.status === 'withdrawn').length;
    },
  },

  actions: {
    async hydrate() {
      const [receipts, queue, cursor] = await Promise.all([db.receipts.toArray(), loadQueue(), loadCursor()]);
      this.receipts = receipts;
      this.queue = queue;
      this.cursor = cursor;
      this.hydrated = true;
    },

    /** 回执库变更后同步给髹漆 store 重算对账视图 */
    syncLacquer() {
      useLacquerStore().syncReceipts(this.receipts);
    },

    /**
     * 把一批外协回执放入待核销队列。
     * 同一回执单号重复送达：已入库或已在队则跳过，不新增遍次、不重复核销。
     * 队列与游标立即持久化，写入失败后已核销位置保留、可重试。
     */
    async enqueue(inputs: ReceiptInput[]): Promise<{ queued: number; skipped: string[] }> {
      const skipped: string[] = [];
      const additions: QueuedReceipt[] = [];
      const known = new Set<string>([
        ...this.receipts.map((r) => r.receiptNo),
        ...this.queue.map((q) => q.receiptNo),
      ]);
      const batchSeen = new Set<string>();
      for (const input of inputs) {
        const receiptNo = input.receiptNo.trim();
        if (!receiptNo || known.has(receiptNo) || batchSeen.has(receiptNo)) {
          skipped.push(receiptNo);
          continue;
        }
        batchSeen.add(receiptNo);
        known.add(receiptNo);
        additions.push({ ...input, receiptNo, queuedAt: new Date().toISOString() });
      }
      const queue = [...this.queue, ...additions];
      await saveQueue(queue);
      const cursor: IngestCursor = this.cursor
        ? { ...this.cursor, total: queue.length, skipped: [...this.cursor.skipped, ...skipped] }
        : { position: 0, total: queue.length, skipped };
      await saveCursor(cursor);
      this.queue = queue;
      this.cursor = cursor;
      return { queued: additions.length, skipped };
    },

    /**
     * 从游标位置继续核销队列。逐条在独立事务内落库 + 重算该琴累计厚度；
     * 某条失败则停在该位置（已核销的保留），记录原因，可再次调用重试。
     */
    async processQueue(): Promise<{ ingested: number }> {
      if (!this.cursor) return { ingested: 0 };
      let ingested = 0;
      let cursor: IngestCursor = { ...this.cursor, error: undefined };
      const touchedGuqin = new Set<string>();
      // 本批已落库回执：连续多张同琴回执时，重算 ctx 需包含前序回执
      const ingestedReceipts: OutsourcedReceipt[] = [];
      try {
        while (cursor.position < this.queue.length) {
          const item = this.queue[cursor.position];
          const guqinNo = item.guqinNo.trim();
          try {
            await db.transaction('rw', db.receipts, db.lacquers, async () => {
              const existed = await db.receipts.where('receiptNo').equals(item.receiptNo).first();
              if (existed) {
                // 极端情况下库里已存在（如恢复备份）：不新增
                return;
              }
              const receipt: OutsourcedReceipt = {
                id: uid('receipt'),
                receiptNo: item.receiptNo,
                batchNo: item.batchNo.trim(),
                guqinNo,
                seq: Number(item.seq) || 0,
                layerThickness: Number(item.layerThickness) || 0,
                mixRatio: item.mixRatio,
                appliedAt: item.appliedAt,
                workshop: item.workshop.trim(),
                status: item.status ?? 'active',
                receivedAt: item.queuedAt,
                remark: item.remark?.trim() || undefined,
              };
              await db.receipts.put(toPlain(receipt));
              ingestedReceipts.push(receipt);
              await recalcTotals(guqinNo, {
                layers: useLacquerStore().layers,
                receipts: [...this.receipts, ...ingestedReceipts],
              });
            });
            touchedGuqin.add(guqinNo);
            cursor = { ...cursor, position: cursor.position + 1 };
            await saveCursor(cursor);
            ingested += 1;
          } catch (error) {
            cursor = {
              ...cursor,
              error: `第 ${cursor.position + 1} 条（回执 ${item.receiptNo}）核销失败：${(error as Error).message}`,
              attemptedAt: new Date().toISOString(),
            };
            await saveCursor(cursor);
            this.cursor = cursor;
            throw error;
          }
        }
        // 全部核销完成：清队列与游标
        await saveQueue([]);
        await saveCursor(null);
        this.queue = [];
        this.cursor = null;
      } finally {
        this.receipts = await db.receipts.toArray();
        this.syncLacquer();
        if (touchedGuqin.size) {
          const lacquerStore = useLacquerStore();
          for (const guqinNo of touchedGuqin) await lacquerStore.refresh(guqinNo);
        }
      }
      return { ingested };
    },

    /** 清空待核销队列（不影响已入库回执） */
    async clearQueue() {
      await saveQueue([]);
      await saveCursor(null);
      this.queue = [];
      this.cursor = null;
    },

    /** 直接登记单张回执（不经队列），落库后立即重算该琴累计厚度 */
    async saveReceipt(input: ReceiptInput, id?: string): Promise<OutsourcedReceipt> {
      const existed = id ? this.receipts.find((r) => r.id === id) : undefined;
      const receipt: OutsourcedReceipt = {
        id: existed?.id ?? uid('receipt'),
        receiptNo: input.receiptNo.trim(),
        batchNo: input.batchNo.trim(),
        guqinNo: input.guqinNo.trim(),
        seq: Number(input.seq) || 0,
        layerThickness: Number(input.layerThickness) || 0,
        mixRatio: input.mixRatio,
        appliedAt: input.appliedAt,
        workshop: input.workshop.trim(),
        status: input.status ?? existed?.status ?? 'active',
        receivedAt: existed?.receivedAt ?? new Date().toISOString(),
        remark: input.remark?.trim() || undefined,
      };
      const nextReceipts = this.receipts.some((r) => r.id === receipt.id)
        ? this.receipts.map((r) => (r.id === receipt.id ? receipt : r))
        : [...this.receipts, receipt];
      await db.transaction('rw', db.receipts, db.lacquers, async () => {
        await db.receipts.put(toPlain(receipt));
        await recalcTotals(receipt.guqinNo, { layers: useLacquerStore().layers, receipts: nextReceipts });
        if (existed && existed.guqinNo !== receipt.guqinNo) {
          await recalcTotals(existed.guqinNo, { layers: useLacquerStore().layers, receipts: nextReceipts });
        }
      });
      this.receipts = await db.receipts.toArray();
      this.syncLacquer();
      const lacquerStore = useLacquerStore();
      await lacquerStore.refresh(receipt.guqinNo);
      if (existed && existed.guqinNo !== receipt.guqinNo) await lacquerStore.refresh(existed.guqinNo);
      return receipt;
    },

    /** 标记回执中途退出：退出后该遍以本坊记录为准，回执不再作为有效依据 */
    async markWithdrawn(id: string) {
      const receipt = this.receipts.find((r) => r.id === id);
      if (!receipt) return;
      const updated = { ...receipt, status: 'withdrawn' as ReceiptStatus };
      await db.transaction('rw', db.receipts, db.lacquers, async () => {
        await db.receipts.put(toPlain(updated));
        await recalcTotals(receipt.guqinNo, {
          layers: useLacquerStore().layers,
          receipts: this.receipts.map((r) => (r.id === id ? updated : r)),
        });
      });
      this.receipts = await db.receipts.toArray();
      this.syncLacquer();
      await useLacquerStore().refresh(receipt.guqinNo);
    },

    /** 撤销中途退出标记（回执重新在途） */
    async markActive(id: string) {
      const receipt = this.receipts.find((r) => r.id === id);
      if (!receipt) return;
      const updated = { ...receipt, status: 'active' as ReceiptStatus };
      await db.transaction('rw', db.receipts, db.lacquers, async () => {
        await db.receipts.put(toPlain(updated));
        await recalcTotals(receipt.guqinNo, {
          layers: useLacquerStore().layers,
          receipts: this.receipts.map((r) => (r.id === id ? updated : r)),
        });
      });
      this.receipts = await db.receipts.toArray();
      this.syncLacquer();
      await useLacquerStore().refresh(receipt.guqinNo);
    },

    async removeReceipt(id: string) {
      const receipt = this.receipts.find((r) => r.id === id);
      await db.transaction('rw', db.receipts, db.lacquers, async () => {
        await db.receipts.delete(id);
        if (receipt) {
          await recalcTotals(receipt.guqinNo, {
            layers: useLacquerStore().layers,
            receipts: this.receipts.filter((r) => r.id !== id),
          });
        }
      });
      this.receipts = await db.receipts.toArray();
      this.syncLacquer();
      if (receipt) {
        await useLacquerStore().refresh(receipt.guqinNo);
      }
    },
  },
});
