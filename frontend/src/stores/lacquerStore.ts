import { defineStore } from 'pinia';
import { db } from '../utils/db';
import { uid } from '../utils/id';
import { toPlain } from '../utils/plain';
import { nextSeq } from '../utils/layer';
import {
  buildRows,
  diffLayerReceipt,
  rowsOfGuqin,
  withSettledCumulative,
  settledTotal,
  pendingCount,
  lacquerSettled,
} from '../utils/reconcile';
import type { LacquerLayer, LayerValueSnapshot } from '../types/lacquer-layer';
import type { LacquerReceipt, LacquerReceiptInput } from '../types/lacquer-receipt';
import type { LacquerJob, LacquerJobKind } from '../types/lacquer-job';
import { LACQUER_STAGE_TARGET_MM } from '../utils/layer';

export interface LacquerInput {
  guqinNo: string;
  mixRatio: string;
  curingTemp: number;
  curingHumidity: number;
  polishGrit: number;
  layerThickness: number;
  appliedAt?: string;
  operator: string;
  remark?: string;
}

interface LacquerState {
  layers: LacquerLayer[];
  receipts: LacquerReceipt[];
  jobs: LacquerJob[];
  hydrated: boolean;
}

/** 登记回执的结果：重复回执只合并、不新增遍次 */
export interface RegisterResult {
  receipt: LacquerReceipt;
  duplicated: boolean;
  jobId?: string;
}

/** 回执去重自然键：回执号优先；缺号时用 琴号+遍次+地方批号+漆坊 */
function receiptKey(r: Pick<LacquerReceipt, 'receiptNo' | 'guqinNo' | 'seq' | 'localBatchNo' | 'workshop'>): string {
  return r.receiptNo.trim()
    ? `no:${r.receiptNo.trim()}`
    : `pos:${r.guqinNo}__${r.seq}__${r.localBatchNo.trim()}__${r.workshop.trim()}`;
}

/** 灰胎遍次（本坊 + 外协核销）、外协回执、核销写入任务 */
export const useLacquerStore = defineStore('lacquer', {
  state: (): LacquerState => ({ layers: [], receipts: [], jobs: [], hydrated: false }),

  getters: {
    layersOf(state) {
      return (guqinNo: string): LacquerLayer[] =>
        rowsOfGuqin(state.layers, state.receipts, guqinNo)
          .map((r) => r.layer)
          .filter((l): l is LacquerLayer => Boolean(l))
          .sort((a, b) => a.seq - b.seq);
    },
    /** 该琴当前有效累计厚度（mm，未决遍次不参与） */
    totalOf(state) {
      return (guqinNo: string): number =>
        settledTotal(
          state.layers.filter((l) => l.guqinNo === guqinNo),
          state.receipts.filter((r) => r.guqinNo === guqinNo),
        );
    },
    /** 该琴的对账行（含本坊遍次、外协回执、状态与差异） */
    rowsOf(state) {
      return (guqinNo: string) => rowsOfGuqin(state.layers, state.receipts, guqinNo);
    },
    receiptsOf(state) {
      return (guqinNo: string): LacquerReceipt[] =>
        state.receipts
          .filter((r) => r.guqinNo === guqinNo)
          .sort((a, b) => a.seq - b.seq || b.lastReceivedAt.localeCompare(a.lastReceivedAt));
    },
    /** 出现在本坊遍次或外协回执中的全部琴号 */
    guqinNos(state): string[] {
      return Array.from(new Set([...state.layers.map((l) => l.guqinNo), ...state.receipts.map((r) => r.guqinNo)])).sort();
    },
    /** 荫房温湿度超窗口的遍次数量（只统计已决遍次，未决数据不采信） */
    outOfRangeCount(state): number {
      return buildRows(state.layers, state.receipts)
        .filter((r) => r.state !== 'disputed' && r.state !== 'receipt-only')
        .map((r) => r.layer)
        .filter((l): l is LacquerLayer => Boolean(l))
        .filter((l) => !(l.curingTemp >= 20 && l.curingTemp <= 30 && l.curingHumidity >= 70 && l.curingHumidity <= 85)).length;
    },
    pendingCount(state): number {
      return pendingCount(state.layers, state.receipts);
    },
    pendingOf(state) {
      return (guqinNo: string): number =>
        pendingCount(
          state.layers.filter((l) => l.guqinNo === guqinNo),
          state.receipts.filter((r) => r.guqinNo === guqinNo),
        );
    },
    failedJobs(state): LacquerJob[] {
      return [...state.jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
  },

  actions: {
    async hydrate() {
      const [layers, receipts, jobs] = await Promise.all([
        db.lacquers.toArray(),
        db.lacquerReceipts.toArray(),
        db.lacquerJobs.toArray(),
      ]);
      this.layers = layers;
      this.receipts = receipts;
      this.jobs = jobs;
      this.hydrated = true;
    },

    /** 追加一遍本坊记录：遍次自动 +1，并重算该琴已核销累计厚度 */
    async appendLayer(input: LacquerInput): Promise<LacquerLayer> {
      const guqinNo = input.guqinNo.trim();
      const siblings = this.layers.filter((l) => l.guqinNo === guqinNo);
      const layer: LacquerLayer = {
        id: uid('layer'),
        guqinNo,
        seq: nextSeq(siblings),
        source: 'local',
        mixRatio: input.mixRatio,
        curingTemp: Number(input.curingTemp) || 0,
        curingHumidity: Number(input.curingHumidity) || 0,
        polishGrit: Number(input.polishGrit) || 0,
        layerThickness: Number(input.layerThickness) || 0,
        totalThickness: 0,
        appliedAt: input.appliedAt ?? new Date().toISOString(),
        operator: input.operator.trim(),
        remark: input.remark?.trim() || undefined,
      };
      await this.persistGuqin(guqinNo, (collections) => {
        collections.layers.push(layer);
      });
      return this.layers.find((l) => l.id === layer.id)!;
    },

    async updateLayer(id: string, patch: Partial<LacquerInput>) {
      const current = this.layers.find((l) => l.id === id);
      if (!current) return;
      const oldGuqinNo = current.guqinNo;
      const next: LacquerLayer = {
        ...current,
        ...patch,
        guqinNo: (patch.guqinNo ?? current.guqinNo).trim(),
        operator: (patch.operator ?? current.operator)?.trim(),
      };
      // 本坊手工编辑视作重新以本坊记录为准：清空待复核标记但保留旧值留档
      if (current.reconcileState === 'disputed') {
        next.reconcileState = undefined;
      }
      await this.persistGuqin(next.guqinNo, (collections) => {
        collections.layers = collections.layers.map((l) => (l.id === id ? next : l));
      });
      if (next.guqinNo !== oldGuqinNo) {
        await this.recomputeOne(oldGuqinNo);
      }
    },

    async removeLayer(id: string) {
      const current = this.layers.find((l) => l.id === id);
      if (!current) return;
      const guqinNo = current.guqinNo;
      await this.persistGuqin(guqinNo, (collections) => {
        collections.layers = collections.layers.filter((l) => l.id !== id);
      });
    },

    /**
     * 登记外协回执：按自然键去重（重复回执不新增遍次，只累加送达次数）。
     * 先落核销任务再执行；写入失败保留任务，可重试。
     */
    async registerReceipt(input: LacquerReceiptInput): Promise<RegisterResult> {
      const payload = this.normalizeReceipt(input);
      let existing: LacquerReceipt | undefined;
      this.receipts.forEach((r) => {
        if (receiptKey(r) === receiptKey(payload)) existing = r;
      });

      const nowIso = new Date().toISOString();
      let receipt: LacquerReceipt;
      let duplicated = false;
      if (existing) {
        duplicated = true;
        receipt = {
          ...existing,
          ...payload,
          id: existing.id,
          receivedAt: existing.receivedAt,
          mergedCount: existing.mergedCount + 1,
          lastReceivedAt: nowIso,
        };
      } else {
        receipt = { ...payload, id: uid('receipt'), receivedAt: nowIso, mergedCount: 0, lastReceivedAt: nowIso };
      }

      const job = this.makeJob('register-receipt', { receipt: toPlain(receipt) });
      await this.saveJob(job);
      try {
        await this.applyRegisterReceipt(receipt);
        await this.clearJob(job.id);
        return { receipt, duplicated };
      } catch (error) {
        await this.markJobError(job.id, error);
        return { receipt, duplicated, jobId: job.id };
      }
    },

    /**
     * 核销某遍次：basis='outsource' 采用外协值（本遍及后续累计、琴坯进度立即失效重算，
     * 本坊旧值存入 valueHistory 留档）；basis='local' 维持本坊值。
     */
    async resolveSeq(guqinNo: string, seq: number, basis: 'local' | 'outsource', receiptId?: string): Promise<string | undefined> {
      const job = this.makeJob('resolve-seq', { guqinNo, seq, basis, receiptId });
      await this.saveJob(job);
      try {
        await this.applyResolveSeq(guqinNo, seq, basis, receiptId);
        await this.clearJob(job.id);
        return undefined;
      } catch (error) {
        await this.markJobError(job.id, error);
        return job.id;
      }
    },

    /** 重新打开对账：恢复本坊旧值并标记待复核，累计与进度随之失效重算 */
    async reopenSeq(guqinNo: string, seq: number): Promise<string | undefined> {
      const job = this.makeJob('reopen-seq', { guqinNo, seq });
      await this.saveJob(job);
      try {
        await this.applyReopenSeq(guqinNo, seq);
        await this.clearJob(job.id);
        return undefined;
      } catch (error) {
        await this.markJobError(job.id, error);
        return job.id;
      }
    },

    /** 删除外协回执（仅回执；若该遍已采用外协值则先恢复待复核） */
    async removeReceipt(id: string): Promise<string | undefined> {
      const target = this.receipts.find((r) => r.id === id);
      if (!target) return undefined;
      const job = this.makeJob('remove-receipt', { guqinNo: target.guqinNo, seq: target.seq, receiptId: id });
      await this.saveJob(job);
      try {
        await this.applyRemoveReceipt(id);
        await this.clearJob(job.id);
        return undefined;
      } catch (error) {
        await this.markJobError(job.id, error);
        return job.id;
      }
    },

    /** 重放失败的核销任务（幂等；成功后删除任务） */
    async retryJob(jobId: string): Promise<boolean> {
      const job = this.jobs.find((j) => j.id === jobId);
      if (!job) return true;
      try {
        if (job.kind === 'register-receipt') {
          await this.applyRegisterReceipt(job.receipt as LacquerReceipt);
        } else if (job.kind === 'resolve-seq') {
          await this.applyResolveSeq(job.guqinNo!, job.seq!, job.basis ?? 'local', job.receiptId);
        } else if (job.kind === 'reopen-seq') {
          await this.applyReopenSeq(job.guqinNo!, job.seq!);
        } else if (job.kind === 'remove-receipt') {
          await this.applyRemoveReceipt(job.receiptId!);
        }
        await this.clearJob(jobId);
        return true;
      } catch (error) {
        await this.markJobError(jobId, error);
        return false;
      }
    },

    /** 放弃失败任务（核销位置尚未生效，仅清掉待重试记录） */
    async discardJob(jobId: string) {
      await db.lacquerJobs.delete(jobId);
      this.jobs = this.jobs.filter((j) => j.id !== jobId);
    },

    // ---------- 内部：幂等应用动作（单事务，失败整体回滚） ----------

    async applyRegisterReceipt(receipt: LacquerReceipt) {
      await this.persistGuqin(receipt.guqinNo, (collections) => {
        const idx = collections.receipts.findIndex((r) => r.id === receipt.id);
        if (idx >= 0) collections.receipts[idx] = receipt;
        else collections.receipts.push(receipt);
      });
    },

    async applyResolveSeq(guqinNo: string, seq: number, basis: 'local' | 'outsource', receiptId?: string) {
      await this.persistGuqin(guqinNo, (collections) => {
        const receipt =
          collections.receipts.find((r) => r.id === receiptId) ?? collections.receipts.find((r) => r.guqinNo === guqinNo && r.seq === seq);
        const existing = collections.layers.find((l) => l.guqinNo === guqinNo && l.seq === seq);

        if (basis === 'outsource') {
          if (!receipt) throw new Error('未找到对应外协回执，无法采用外协值');
          if (!existing) {
            // 仅回执（外协批号对得上琴号遍次、本坊漏登）：采用时补建本坊遍次，来源标外协
            collections.layers.push({
              id: uid('layer'),
              guqinNo,
              seq,
              source: 'outsource',
              reconcileState: 'resolved-outsource',
              receiptId: receipt.id,
              mixRatio: receipt.mixRatio,
              curingTemp: receipt.curingTemp ?? 0,
              curingHumidity: receipt.curingHumidity ?? 0,
              polishGrit: receipt.polishGrit ?? 0,
              layerThickness: receipt.layerThickness,
              totalThickness: 0,
              appliedAt: receipt.appliedAt,
              operator: receipt.operator?.trim() || receipt.workshop,
              remark: receipt.remark?.trim() || `外协 ${receipt.workshop} 回执入账`,
              valueHistory: [],
            });
          } else {
            // 已存在本坊遍次：旧值先留档，再以回执值覆盖；该遍及后续累计立即重算
            const snapshot: LayerValueSnapshot = {
              id: uid('snap'),
              savedAt: new Date().toISOString(),
              basis: 'local',
              mixRatio: existing.mixRatio,
              layerThickness: existing.layerThickness,
              appliedAt: existing.appliedAt,
            };
            const resolved: LacquerLayer = {
              ...existing,
              source: 'outsource',
              receiptId: receipt.id,
              reconcileState: 'resolved-outsource',
              mixRatio: receipt.mixRatio,
              layerThickness: receipt.layerThickness,
              appliedAt: receipt.appliedAt,
              ...(receipt.curingTemp !== undefined ? { curingTemp: receipt.curingTemp } : {}),
              ...(receipt.curingHumidity !== undefined ? { curingHumidity: receipt.curingHumidity } : {}),
              ...(receipt.polishGrit !== undefined ? { polishGrit: receipt.polishGrit } : {}),
              valueHistory: [snapshot, ...(existing.valueHistory ?? [])],
            };
            collections.layers = collections.layers.map((l) => (l.id === existing.id ? resolved : l));
          }
        } else {
          if (!existing) throw new Error('本坊无此遍次记录，无法维持本坊值');
          collections.layers = collections.layers.map((l) =>
            l.guqinNo === guqinNo && l.seq === seq ? { ...l, reconcileState: 'resolved-local', receiptId: receipt?.id ?? l.receiptId } : l,
          );
        }
      });
    },

    async applyReopenSeq(guqinNo: string, seq: number) {
      await this.persistGuqin(guqinNo, (collections) => {
        const layer = collections.layers.find((l) => l.guqinNo === guqinNo && l.seq === seq);
        if (!layer) return;
        const receipt = collections.receipts.find((r) => r.guqinNo === guqinNo && r.seq === seq);
        // 曾采用外协值：恢复留档的本坊旧值，旧值仍保留在历史中可查阅
        const localSnapshot = (layer.valueHistory ?? []).find((s) => s.basis === 'local');
        const restored: LacquerLayer = localSnapshot
          ? {
              ...layer,
              mixRatio: localSnapshot.mixRatio,
              layerThickness: localSnapshot.layerThickness,
              appliedAt: localSnapshot.appliedAt,
              source: 'local',
            }
          : { ...layer };
        // 回执还在且仍有差异才回到待复核；回执已删/已一致则恢复为普通本坊记录
        const stillDisputed = receipt
          ? (() => {
              const diff = diffLayerReceipt(restored, receipt);
              return diff.thickness || diff.mixRatio || diff.appliedAt;
            })()
          : false;
        const next: LacquerLayer = {
          ...restored,
          reconcileState: stillDisputed ? 'disputed' : undefined,
          receiptId: stillDisputed ? receipt?.id ?? layer.receiptId : undefined,
        };
        collections.layers = collections.layers.map((l) => (l.id === layer.id ? next : l));
      });
    },

    async applyRemoveReceipt(receiptId: string) {
      const target = this.receipts.find((r) => r.id === receiptId);
      if (!target) return;
      const { guqinNo } = target;
      await this.persistGuqin(guqinNo, (collections) => {
        collections.receipts = collections.receipts.filter((r) => r.id !== receiptId);
        collections.layers = collections.layers.map((l) => {
          if (!(l.guqinNo === guqinNo && l.seq === target.seq && l.receiptId === receiptId)) return l;
          // 失去回执：回到待复核，并恢复留档的本坊旧值（若有）
          const localSnapshot = (l.valueHistory ?? []).find((s) => s.basis === 'local');
          return {
            ...l,
            reconcileState: 'disputed' as const,
            receiptId: undefined,
            ...(localSnapshot
              ? { mixRatio: localSnapshot.mixRatio, layerThickness: localSnapshot.layerThickness, appliedAt: localSnapshot.appliedAt, source: 'local' as const }
              : {}),
          };
        });
      });
    },

    // ---------- 内部：落库与重算 ----------

    normalizeReceipt(input: LacquerReceiptInput): Omit<LacquerReceipt, 'id' | 'receivedAt' | 'mergedCount' | 'lastReceivedAt'> {
      return {
        receiptNo: input.receiptNo.trim(),
        workshop: input.workshop.trim(),
        localBatchNo: input.localBatchNo.trim(),
        guqinNo: input.guqinNo.trim(),
        seq: Math.max(1, Number(input.seq) || 0),
        layerThickness: Number(input.layerThickness) || 0,
        mixRatio: input.mixRatio.trim(),
        appliedAt: input.appliedAt ?? new Date().toISOString(),
        ...(input.curingTemp !== undefined && input.curingTemp !== null && !Number.isNaN(input.curingTemp)
          ? { curingTemp: Number(input.curingTemp) }
          : {}),
        ...(input.curingHumidity !== undefined && input.curingHumidity !== null && !Number.isNaN(input.curingHumidity)
          ? { curingHumidity: Number(input.curingHumidity) }
          : {}),
        ...(input.polishGrit !== undefined && input.polishGrit !== null && !Number.isNaN(input.polishGrit)
          ? { polishGrit: Number(input.polishGrit) }
          : {}),
        ...(input.operator?.trim() ? { operator: input.operator.trim() } : {}),
        ...(input.remark?.trim() ? { remark: input.remark.trim() } : {}),
      };
    },

    makeJob(kind: LacquerJobKind, patch: Partial<LacquerJob>): LacquerJob {
      return {
        id: uid('job'),
        kind,
        createdAt: new Date().toISOString(),
        lastError: '',
        attempts: 0,
        ...patch,
      };
    },

    async saveJob(job: LacquerJob) {
      await db.lacquerJobs.put(toPlain(job));
      this.jobs = [...this.jobs.filter((j) => j.id !== job.id), job];
    },

    async clearJob(jobId: string) {
      await db.lacquerJobs.delete(jobId);
      this.jobs = this.jobs.filter((j) => j.id !== jobId);
    },

    async markJobError(jobId: string, error: unknown) {
      const current = this.jobs.find((j) => j.id === jobId);
      if (!current) return;
      const next: LacquerJob = { ...current, attempts: current.attempts + 1, lastError: (error as Error)?.message || String(error) };
      await db.lacquerJobs.put(toPlain(next));
      this.jobs = this.jobs.map((j) => (j.id === jobId ? next : j));
    },

    /**
     * 在单事务内对一张琴的遍次+回执做改动，并重算累计厚度后整体写库；
     * 事务失败则全部回滚，已核销的其它位置不受影响（配合 lacquerJobs 可重试）。
     */
    async persistGuqin(
      guqinNo: string,
      mutate: (collections: { layers: LacquerLayer[]; receipts: LacquerReceipt[] }) => void,
    ) {
      const snapshot = {
        layers: this.layers.filter((l) => l.guqinNo === guqinNo).map((l) => ({ ...l })),
        receipts: this.receipts.filter((r) => r.guqinNo === guqinNo).map((r) => ({ ...r })),
      };
      const working = { layers: snapshot.layers.map((l) => ({ ...l })), receipts: snapshot.receipts.map((r) => ({ ...r })) };
      mutate(working);

      const rows = rowsOfGuqin(working.layers, working.receipts, guqinNo);
      const recalculated = withSettledCumulative(rows);
      const finalLayers = working.layers.map((l) => recalculated.find((r) => r.id === l.id) ?? l);

      await db.transaction('rw', db.lacquers, db.lacquerReceipts, async () => {
        // 先清掉该琴旧记录，再写新结果（同一事务，失败回滚）
        const layerIds = snapshot.layers.map((l) => l.id);
        const receiptIds = snapshot.receipts.map((r) => r.id);
        if (layerIds.length) await db.lacquers.bulkDelete(layerIds);
        if (receiptIds.length) await db.lacquerReceipts.bulkDelete(receiptIds);
        if (finalLayers.length) await db.lacquers.bulkPut(toPlain(finalLayers));
        if (working.receipts.length) await db.lacquerReceipts.bulkPut(toPlain(working.receipts));
      });

      // 提交成功后再切换内存状态
      const otherLayers = this.layers.filter((l) => l.guqinNo !== guqinNo);
      const otherReceipts = this.receipts.filter((r) => r.guqinNo !== guqinNo);
      this.layers = [...otherLayers, ...finalLayers];
      this.receipts = [...otherReceipts, ...working.receipts];
    },

    /** 仅重算某琴累计（不改结构），用于改琴号后清理旧分组 */
    async recomputeOne(guqinNo: string) {
      const layers = this.layers.filter((l) => l.guqinNo === guqinNo);
      const receipts = this.receipts.filter((r) => r.guqinNo === guqinNo);
      if (!layers.length && !receipts.length) return;
      const rows = rowsOfGuqin(layers, receipts, guqinNo);
      const recalculated = withSettledCumulative(rows);
      if (recalculated.length) {
        await db.lacquers.bulkPut(toPlain(recalculated));
        this.layers = this.layers.map((l) => recalculated.find((r) => r.id === l.id) ?? l);
      }
    },

    /** 该琴灰胎是否达到可上弦条件：累计达标且无未决遍次 */
    isLacquerReady(guqinNo: string, targetMm: number = LACQUER_STAGE_TARGET_MM): boolean {
      return lacquerSettled(
        this.layers.filter((l) => l.guqinNo === guqinNo),
        this.receipts.filter((r) => r.guqinNo === guqinNo),
        targetMm,
      );
    },
  },
});
