import type { LacquerLayer } from '../types/lacquer-layer';
import type { LacquerReceipt } from '../types/lacquer-receipt';
import { sortLayers } from './layer';

/** 对账行状态（含由双方值实时派生的 matched） */
export type RowState =
  | 'local-only' // 仅本坊记录（含历史无来源标记的兼容遍次）
  | 'matched' // 本坊值与回执值一致
  | 'disputed' // 双方都在但厚度/配比/施工日期不一致，待复核
  | 'resolved-local' // 已核销：维持本坊值
  | 'resolved-outsource' // 已核销：采用外协值
  | 'receipt-only'; // 仅回执，本坊无此遍次（外协批号对不上/中途退出）

export interface ReconcileDiff {
  thickness: boolean;
  mixRatio: boolean;
  appliedAt: boolean;
}

/** 一条按琴号+遍次合并后的对账行 */
export interface LacquerRow {
  guqinNo: string;
  seq: number;
  layer?: LacquerLayer;
  receipt?: LacquerReceipt;
  state: RowState;
  diff?: ReconcileDiff;
  /** 参与累计的有效厚度；未决行为 0（未决遍次不参与累计） */
  effectiveThickness: number;
}

/** 厚度比对容差（mm，规避浮点尾差） */
const THICKNESS_EPS = 0.001;

function dayOf(value: string): string {
  // 统一取 yyyy-mm-dd 比对施工日期
  return new Date(value).toISOString().slice(0, 10);
}

/** 比对双方厚度/配比/施工日期是否一致 */
export function diffLayerReceipt(layer: LacquerLayer, receipt: LacquerReceipt): ReconcileDiff {
  return {
    thickness: Math.abs((Number(layer.layerThickness) || 0) - (Number(receipt.layerThickness) || 0)) > THICKNESS_EPS,
    mixRatio: layer.mixRatio.trim() !== receipt.mixRatio.trim(),
    appliedAt: dayOf(layer.appliedAt) !== dayOf(receipt.appliedAt),
  };
}

export function hasDiff(diff: ReconcileDiff): boolean {
  return diff.thickness || diff.mixRatio || diff.appliedAt;
}

/** 该遍次是否已决（可参与累计）；本坊单方记录视为已决 */
export function isSettled(state: RowState): boolean {
  return state === 'local-only' || state === 'matched' || state === 'resolved-local' || state === 'resolved-outsource';
}

/** 本遍次是否参与累计（未决遍次不参与） */
export function rowIncluded(row: LacquerRow): boolean {
  return isSettled(row.state);
}

function rowState(layer: LacquerLayer | undefined, receipt: LacquerReceipt | undefined): RowState {
  if (layer && !receipt) return 'local-only';
  if (!layer && receipt) return 'receipt-only';
  if (!layer || !receipt) return 'local-only';
  switch (layer.reconcileState) {
    case 'resolved-local':
      return 'resolved-local';
    case 'resolved-outsource':
      return 'resolved-outsource';
    case 'disputed':
      return 'disputed';
    default:
      return hasDiff(diffLayerReceipt(layer, receipt)) ? 'disputed' : 'matched';
  }
}

/** 按琴号+遍次把本坊遍次与外协回执对账合并（返回按遍次升序、末尾补孤儿回执） */
export function buildRows(layers: LacquerLayer[], receipts: LacquerReceipt[]): LacquerRow[] {
  const layerMap = new Map<string, LacquerLayer>();
  layers.forEach((l) => layerMap.set(`${l.guqinNo}__${l.seq}`, l));
  const receiptMap = new Map<string, LacquerReceipt>();
  receipts.forEach((r) => {
    const key = `${r.guqinNo}__${r.seq}`;
    // 同一琴号+遍次理论上只留一张回执（重复回执在登记时合并），防御性取送达最近的一张
    const prev = receiptMap.get(key);
    if (!prev || r.lastReceivedAt >= prev.lastReceivedAt) receiptMap.set(key, r);
  });

  const keys = new Set<string>([...layerMap.keys(), ...receiptMap.keys()]);
  const rows: LacquerRow[] = [];
  keys.forEach((key) => {
    const [guqinNo, seqStr] = key.split('__');
    const seq = Number(seqStr);
    const layer = layerMap.get(key);
    const receipt = receiptMap.get(key);
    const state = rowState(layer, receipt);
    rows.push({
      guqinNo,
      seq,
      layer,
      receipt,
      state,
      diff: layer && receipt ? diffLayerReceipt(layer, receipt) : undefined,
      effectiveThickness: isSettled(state) ? Number(layer?.layerThickness ?? 0) : 0,
    });
  });
  return rows.sort((a, b) => (a.guqinNo === b.guqinNo ? a.seq - b.seq : a.guqinNo.localeCompare(b.guqinNo)));
}

/** 某张琴的对账行（按遍次升序） */
export function rowsOfGuqin(layers: LacquerLayer[], receipts: LacquerReceipt[], guqinNo: string): LacquerRow[] {
  return buildRows(layers, receipts)
    .filter((r) => r.guqinNo === guqinNo)
    .sort((a, b) => a.seq - b.seq);
}

/** 参与累计的遍次（仅已决行对应的本坊遍次） */
export function includedLayers(layers: LacquerLayer[], receipts: LacquerReceipt[]): LacquerLayer[] {
  const settled = new Set(buildRows(layers, receipts).filter(rowIncluded).map((r) => r.layer?.id).filter(Boolean) as string[]);
  return layers.filter((l) => settled.has(l.id));
}

/** 有效累计厚度：只累加已核销遍次 */
export function settledTotal(layers: LacquerLayer[], receipts: LacquerReceipt[]): number {
  const sum = includedLayers(layers, receipts).reduce((acc, l) => acc + (Number(l.layerThickness) || 0), 0);
  return Number(sum.toFixed(3));
}

/**
 * 回填某张琴各遍的累计厚度：未决遍次沿用上一已核销遍的累计值（且不参与后续累计）。
 * 返回需要落库的新遍次数组（含本坊新增/被外协值替换的遍次）。
 */
export function withSettledCumulative(rows: LacquerRow[]): LacquerLayer[] {
  let run = 0;
  return rows
    .filter((r): r is LacquerRow & { layer: LacquerLayer } => Boolean(r.layer))
    .map((r) => {
      if (rowIncluded(r)) run = Number((run + (Number(r.layer.layerThickness) || 0)).toFixed(3));
      return { ...r.layer, totalThickness: run };
    });
}

/** 待复核遍次数（双方冲突 + 仅回执未入册） */
export function pendingCount(layers: LacquerLayer[], receipts: LacquerReceipt[]): number {
  return buildRows(layers, receipts).filter((r) => r.state === 'disputed' || r.state === 'receipt-only').length;
}

/** 某琴灰胎是否完成：累计达标且无未决遍次 */
export function lacquerSettled(layers: LacquerLayer[], receipts: LacquerReceipt[], targetMm: number): boolean {
  const rows = buildRows(layers, receipts);
  const hasPending = rows.some((r) => !isSettled(r.state));
  return !hasPending && settledTotal(layers, receipts) >= targetMm;
}

/** 排序后遍次数组（供 UI） */
export function sortedLayersOf(layers: LacquerLayer[], guqinNo: string): LacquerLayer[] {
  return sortLayers(layers.filter((l) => l.guqinNo === guqinNo));
}
