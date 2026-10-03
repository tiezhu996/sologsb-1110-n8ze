import { defineStore } from 'pinia';
import { db } from '../utils/db';
import { uid } from '../utils/id';
import { toPlain } from '../utils/plain';
import { nextSeq, sortLayers } from '../utils/layer';
import { recalcTotals } from '../utils/recalc';
import { reconcile, isEffectiveRow, isOpenRow, layerSource, receiptFingerprint } from '../utils/reconcile';
import type { LayerSnapshot, LacquerLayer } from '../types/lacquer-layer';
import type { LayerSource, OutsourcedReceipt, Resolution } from '../types/outsourced';

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
  source?: LayerSource;
}

interface LacquerState {
  layers: LacquerLayer[];
  /** 外协回执副本，供对账派生；由回执 store 同步 */
  receipts: OutsourcedReceipt[];
  hydrated: boolean;
}

/** 髹漆遍次与累计厚度（累计只含已核销/可核销遍次，由对账结果派生） */
export const useLacquerStore = defineStore('lacquer', {
  state: (): LacquerState => ({ layers: [], receipts: [], hydrated: false }),

  getters: {
    layersOf(state) {
      return (guqinNo: string): LacquerLayer[] => sortLayers(state.layers.filter((l) => l.guqinNo === guqinNo));
    },
    /** 全部对账行（按琴号+遍次） */
    reconRows(state) {
      return reconcile(state.layers, state.receipts);
    },
    /** 该琴当前可核销累计厚度（mm），未决遍次不计入 */
    totalOf(state) {
      return (guqinNo: string): number => {
        const total = reconcile(state.layers, state.receipts)
          .filter((row) => row.guqinNo === guqinNo && isEffectiveRow(row) && row.local)
          .reduce((acc, row) => acc + (Number(row.local!.layerThickness) || 0), 0);
        return Number(total.toFixed(3));
      };
    },
    /** 待复核/遍次对不上的未决对账行（可按琴过滤） */
    openRows(state) {
      return (guqinNo?: string) =>
        reconcile(state.layers, state.receipts).filter((row) => (!guqinNo || row.guqinNo === guqinNo) && isOpenRow(row));
    },
    /** 待复核/遍次对不上的未决遍次数（全坊） */
    openCount(): number {
      return this.openRows().length;
    },
    guqinNos(state): string[] {
      return Array.from(new Set(state.layers.map((l) => l.guqinNo))).sort();
    },
    /** 荫房温湿度超窗口的遍次数量 */
    outOfRangeCount(state): number {
      return state.layers.filter((l) => !(l.curingTemp >= 20 && l.curingTemp <= 30 && l.curingHumidity >= 70 && l.curingHumidity <= 85)).length;
    },
  },

  actions: {
    async hydrate() {
      const [layers, receipts] = await Promise.all([db.lacquers.toArray(), db.receipts.toArray()]);
      this.layers = layers;
      this.receipts = receipts;
      this.hydrated = true;
    },

    /** 回执变更后同步进对账视图（由 receiptStore 调用） */
    syncReceipts(receipts: OutsourcedReceipt[]) {
      this.receipts = receipts;
    },

    /** 用库中最新结果替换本坊遍次（重算/裁决后调用） */
    async refresh(guqinNo?: string) {
      if (guqinNo) {
        const fresh = await db.lacquers.where('guqinNo').equals(guqinNo).toArray();
        this.layers = [...this.layers.filter((l) => l.guqinNo !== guqinNo), ...fresh];
      } else {
        this.layers = await db.lacquers.toArray();
      }
    },

    /** 追加一遍：遍次自动 +1，落库后按对账结果重算该琴累计厚度 */
    async appendLayer(input: LacquerInput): Promise<LacquerLayer> {
      const siblings = this.layers.filter((l) => l.guqinNo === input.guqinNo);
      const layer: LacquerLayer = {
        id: uid('layer'),
        guqinNo: input.guqinNo.trim(),
        seq: nextSeq(siblings),
        source: input.source ?? 'local',
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
      const nextLayers = [...siblings, layer];
      const allLayers = [...this.layers.filter((l) => l.guqinNo !== layer.guqinNo), ...nextLayers];
      await db.transaction('rw', db.lacquers, db.receipts, async () => {
        await db.lacquers.put(toPlain(layer));
        await recalcTotals(layer.guqinNo, { layers: allLayers, receipts: this.receipts });
      });
      await this.refresh(layer.guqinNo);
      return (await db.lacquers.get(layer.id))!;
    },

    async updateLayer(id: string, patch: Partial<LacquerInput>) {
      const current = this.layers.find((l) => l.id === id);
      if (!current) return;
      const next: LacquerLayer = {
        ...current,
        ...patch,
        guqinNo: patch.guqinNo?.trim() ?? current.guqinNo,
        source: patch.source ?? layerSource(current),
      };
      const allLayers = this.layers.map((l) => (l.id === id ? next : l));
      await db.transaction('rw', db.lacquers, db.receipts, async () => {
        await db.lacquers.put(toPlain(next));
        await recalcTotals(next.guqinNo, { layers: allLayers, receipts: this.receipts });
        if (next.guqinNo !== current.guqinNo) {
          await recalcTotals(current.guqinNo, { layers: allLayers, receipts: this.receipts });
        }
      });
      await this.refresh(next.guqinNo);
      if (next.guqinNo !== current.guqinNo) await this.refresh(current.guqinNo);
    },

    async removeLayer(id: string) {
      const current = this.layers.find((l) => l.id === id);
      const restLayers = this.layers.filter((l) => l.id !== id);
      await db.transaction('rw', db.lacquers, db.receipts, async () => {
        await db.lacquers.delete(id);
        if (current) await recalcTotals(current.guqinNo, { layers: restLayers, receipts: this.receipts });
      });
      if (current) await this.refresh(current.guqinNo);
      else this.layers = await db.lacquers.toArray();
    },

    /**
     * 待复核裁决：采用外协回执值。
     * 裁决前把本坊旧值存快照（旧值仍可查阅），随后该遍及后续累计厚度立即重算。
     */
    async resolveWithReceipt(row: { guqinNo: string; seq: number }) {
      const layer = this.layers.find((l) => l.guqinNo === row.guqinNo && l.seq === row.seq);
      const receipt = this.receipts.find((r) => r.guqinNo === row.guqinNo && r.seq === row.seq);
      if (!layer || !receipt) return;
      const snapshot: LayerSnapshot = {
        savedAt: new Date().toISOString(),
        resolution: 'receipt',
        receiptNo: receipt.receiptNo,
        layerThickness: layer.layerThickness,
        mixRatio: layer.mixRatio,
        appliedAt: layer.appliedAt,
      };
      const next: LacquerLayer = {
        ...layer,
        layerThickness: receipt.layerThickness,
        mixRatio: receipt.mixRatio,
        appliedAt: receipt.appliedAt,
        resolution: 'receipt',
        reconciledReceiptNo: receipt.receiptNo,
        reconciledAt: new Date().toISOString(),
        resolvedFingerprint: undefined,
        snapshots: [snapshot, ...(layer.snapshots ?? [])],
      };
      const allLayers = this.layers.map((l) => (l.id === next.id ? next : l));
      await db.transaction('rw', db.lacquers, db.receipts, async () => {
        await db.lacquers.put(toPlain(next));
        await recalcTotals(next.guqinNo, { layers: allLayers, receipts: this.receipts });
      });
      await this.refresh(next.guqinNo);
    },

    /**
     * 待复核裁决：保留本坊记录值。
     * 记录裁决时的回执指纹：回执日后再被改成不一致时，自动回到待复核。
     */
    async resolveWithLocal(row: { guqinNo: string; seq: number }) {
      const layer = this.layers.find((l) => l.guqinNo === row.guqinNo && l.seq === row.seq);
      const receipt = this.receipts.find((r) => r.guqinNo === row.guqinNo && r.seq === row.seq);
      if (!layer || !receipt) return;
      const next: LacquerLayer = {
        ...layer,
        resolution: 'local' as Resolution,
        reconciledReceiptNo: receipt.receiptNo,
        reconciledAt: new Date().toISOString(),
        resolvedFingerprint: receiptFingerprint(receipt),
      };
      const allLayers = this.layers.map((l) => (l.id === next.id ? next : l));
      await db.transaction('rw', db.lacquers, db.receipts, async () => {
        await db.lacquers.put(toPlain(next));
        await recalcTotals(next.guqinNo, { layers: allLayers, receipts: this.receipts });
      });
      await this.refresh(next.guqinNo);
    },
  },
});
