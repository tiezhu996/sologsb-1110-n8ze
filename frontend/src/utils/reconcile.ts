import type { LacquerLayer } from '../types/lacquer-layer';
import type { DiffField, OutsourcedReceipt, ReconStatus } from '../types/outsourced';

/** 历史遍次缺来源标记时，按本坊记录兼容 */
export function layerSource(layer: LacquerLayer): 'local' | 'outsourced' {
  return layer.source === 'outsourced' ? 'outsourced' : 'local';
}

/** 只按日历日比较施工日期，忽略时分秒 */
export function sameDay(a: string, b: string): boolean {
  return new Date(a).toISOString().slice(0, 10) === new Date(b).toISOString().slice(0, 10);
}

/** 厚度一致（mm，保留三位小数容差） */
export function sameThickness(a: number, b: number): boolean {
  return Math.abs((Number(a) || 0) - (Number(b) || 0)) < 0.0005;
}

/** 回执侧（或裁决后认定）的厚度/配比/施工日期指纹 */
export function receiptFingerprint(receipt: Pick<OutsourcedReceipt, 'layerThickness' | 'mixRatio' | 'appliedAt'>): string {
  return [Number(receipt.layerThickness) || 0, receipt.mixRatio, new Date(receipt.appliedAt).toISOString().slice(0, 10)].join('|');
}

/** 一条对账结果：本地遍次与外协回执按琴号+遍次配对后的双边视图 */
export interface ReconRow {
  key: string;
  guqinNo: string;
  seq: number;
  local?: LacquerLayer;
  receipt?: OutsourcedReceipt;
  status: ReconStatus;
  diffs: DiffField[];
  /** 裁决后指纹（裁决行随回执变更可回到待复核） */
  fingerprint?: string;
}

function diffFields(layer: LacquerLayer, receipt: OutsourcedReceipt): DiffField[] {
  const diffs: DiffField[] = [];
  if (!sameThickness(layer.layerThickness, receipt.layerThickness)) diffs.push('layerThickness');
  if (layer.mixRatio !== receipt.mixRatio) diffs.push('mixRatio');
  if (!sameDay(layer.appliedAt, receipt.appliedAt)) diffs.push('appliedAt');
  return diffs;
}

/**
 * 把本地髹漆遍次与外协回执分成两套来源，按琴号+遍次对账：
 * - 双边齐全且一致：已核销
 * - 双边齐全但厚度/配比/施工日期不一致：待复核，保留双方
 * - 仅本坊有：回执未到（本坊记录照常计入）
 * - 仅回执有：遍次对不上，待复核，不参与累计
 * - 回执中途退出：以本坊记录为准
 */
export function reconcile(layers: LacquerLayer[], receipts: OutsourcedReceipt[]): ReconRow[] {
  const rows = new Map<string, ReconRow>();
  const keyOf = (guqinNo: string, seq: number) => `${guqinNo}#${seq}`;

  for (const layer of layers) {
    rows.set(keyOf(layer.guqinNo, layer.seq), {
      key: keyOf(layer.guqinNo, layer.seq),
      guqinNo: layer.guqinNo,
      seq: layer.seq,
      local: layer,
      status: 'pending-local',
      diffs: [],
    });
  }

  for (const receipt of receipts) {
    const key = keyOf(receipt.guqinNo, receipt.seq);
    const row = rows.get(key);
    if (!row) {
      // 回执对不上任何本地遍次（地方批号/遍次错位、或中途退出前本坊未立遍）
      rows.set(key, {
        key,
        guqinNo: receipt.guqinNo,
        seq: receipt.seq,
        receipt,
        status: receipt.status === 'withdrawn' ? 'withdrawn' : 'pending-receipt',
        diffs: [],
      });
      continue;
    }
    row.receipt = receipt;
    const layer = row.local!;
    if (receipt.status === 'withdrawn') {
      row.status = 'withdrawn';
      continue;
    }
    const diffs = diffFields(layer, receipt);
    if (diffs.length === 0) {
      row.status = 'reconciled';
      row.fingerprint = receiptFingerprint(receipt);
    } else if (
      // 已裁决「保留本坊值」且回执仍是裁决时的回执：维持核销
      layer.resolution === 'local' &&
      layer.resolvedFingerprint === receiptFingerprint(receipt)
    ) {
      row.status = 'reconciled';
      row.fingerprint = layer.resolvedFingerprint;
    } else {
      // 「采用外协值」后本坊值被改离回执，或回执改离裁决值，均重新回到待复核
      row.status = 'disputed';
      row.diffs = diffs;
    }
  }

  return [...rows.values()].sort((a, b) =>
    a.guqinNo === b.guqinNo ? a.seq - b.seq : a.guqinNo.localeCompare(b.guqinNo),
  );
}

/**
 * 该遍是否可计入累计厚度：
 * - 待复核遍次不参与累计
 * - 对不上的回执（无本地遍次）不参与累计
 * - 回执未到的本坊遍次照常计入
 * - 外协中途退出后，以本坊记录为准，照常计入
 */
export function isEffectiveRow(row: ReconRow): boolean {
  return row.status === 'reconciled' || row.status === 'pending-local' || row.status === 'withdrawn';
}

/** 未决：待复核差异 / 遍次对不上，需人工核销；会阻塞灰胎完工与上弦 */
export function isOpenRow(row: ReconRow): boolean {
  return row.status === 'disputed' || row.status === 'pending-receipt';
}

/** 某琴的可核销（计入累计）本地遍次，按遍次升序 */
export function effectiveLayersOf(guqinNo: string, layers: LacquerLayer[], receipts: OutsourcedReceipt[]): LacquerLayer[] {
  const effective = new Set(
    reconcile(layers, receipts)
      .filter((row) => row.guqinNo === guqinNo && isEffectiveRow(row) && row.local)
      .map((row) => row.local!.id),
  );
  return layers.filter((l) => l.guqinNo === guqinNo && effective.has(l.id)).sort((a, b) => a.seq - b.seq);
}

/** 某琴的未决对账行 */
export function openRowsOf(guqinNo: string, layers: LacquerLayer[], receipts: OutsourcedReceipt[]): ReconRow[] {
  return reconcile(layers, receipts).filter((row) => row.guqinNo === guqinNo && isOpenRow(row));
}

/** 某琴累计厚度（mm），只计可核销遍次 */
export function effectiveCumulativeOf(guqinNo: string, layers: LacquerLayer[], receipts: OutsourcedReceipt[]): number {
  const total = effectiveLayersOf(guqinNo, layers, receipts).reduce((acc, layer) => acc + (Number(layer.layerThickness) || 0), 0);
  return Number(total.toFixed(3));
}

/** 某琴在指定遍次处（含）的累计厚度，供遍次明细列示 */
export function effectiveCumulativeAt(guqinNo: string, seq: number, layers: LacquerLayer[], receipts: OutsourcedReceipt[]): number {
  const total = effectiveLayersOf(guqinNo, layers, receipts)
    .filter((layer) => layer.seq <= seq)
    .reduce((acc, layer) => acc + (Number(layer.layerThickness) || 0), 0);
  return Number(total.toFixed(3));
}

/** 灰胎完工目标累计厚度（mm） */
export const GRAY_BODY_TARGET_MM = 1.0;

/** 灰胎是否完工：无未决对账项，且可核销遍次累计厚度达标 */
export function grayBodyReady(guqinNo: string, layers: LacquerLayer[], receipts: OutsourcedReceipt[], targetMm = GRAY_BODY_TARGET_MM): boolean {
  return openRowsOf(guqinNo, layers, receipts).length === 0 && effectiveCumulativeOf(guqinNo, layers, receipts) >= targetMm;
}

/** 上弦闸门的阻塞原因（空数组表示可上弦） */
export function stringingBlockers(guqinNo: string, layers: LacquerLayer[], receipts: OutsourcedReceipt[]): string[] {
  const blockers: string[] = [];
  const open = openRowsOf(guqinNo, layers, receipts);
  if (open.length) {
    const disputed = open.filter((r) => r.status === 'disputed').length;
    const orphan = open.filter((r) => r.status === 'pending-receipt').length;
    const parts: string[] = [];
    if (disputed) parts.push(`${disputed} 遍回执与本坊记录不一致待复核`);
    if (orphan) parts.push(`${orphan} 张回执遍次对不上待复核`);
    blockers.push(`灰胎存在未决核销：${parts.join('；')}`);
  }
  if (effectiveCumulativeOf(guqinNo, layers, receipts) < GRAY_BODY_TARGET_MM) {
    blockers.push(`可核销累计厚度未达 ${GRAY_BODY_TARGET_MM}mm（未决遍次不计入）`);
  }
  return blockers;
}
