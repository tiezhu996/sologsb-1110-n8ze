import { db } from './db';
import { toPlain } from './plain';
import { effectiveCumulativeAt, reconcile, isEffectiveRow } from './reconcile';
import type { LacquerLayer } from '../types/lacquer-layer';
import type { OutsourcedReceipt } from '../types/outsourced';

/**
 * 按对账结果重算指定琴（或全部琴）各遍累计厚度并落库。
 * 未决遍次（待复核 / 遍次对不上）不参与累计；可核销遍次的累计值只累加其之前的可核销遍次。
 *
 * 在事务内调用时，务必把事务内最新的 layers/receipts 作为 ctx 传入，
 * 使读取与写入并入同一事务（Dexie 不允许事务回调里另开未纳入事务的读操作）：
 * 写入失败随外层事务整体回滚，已核销位置不会留下半截数据。
 */
export async function recalcTotals(
  guqinNo?: string,
  ctx?: { layers: LacquerLayer[]; receipts: OutsourcedReceipt[] },
): Promise<LacquerLayer[]> {
  const layers = ctx?.layers ?? (await db.lacquers.toArray());
  const receipts = ctx?.receipts ?? (await db.receipts.toArray());
  const rows = reconcile(layers, receipts);
  const targets = guqinNo ? new Set([guqinNo]) : new Set(rows.map((row) => row.guqinNo));

  const effectiveSeqs = new Map<string, Set<number>>();
  rows.filter(isEffectiveRow).forEach((row) => {
    if (!row.local) return;
    const set = effectiveSeqs.get(row.guqinNo) ?? new Set<number>();
    set.add(row.seq);
    effectiveSeqs.set(row.guqinNo, set);
  });

  const changed: LacquerLayer[] = [];
  for (const layer of layers) {
    if (!targets.has(layer.guqinNo)) continue;
    const seqs = effectiveSeqs.get(layer.guqinNo) ?? new Set<number>();
    const total = seqs.has(layer.seq) ? effectiveCumulativeAt(layer.guqinNo, layer.seq, layers, receipts) : 0;
    if (Number((layer.totalThickness ?? 0).toFixed(3)) !== total) {
      const next = { ...layer, totalThickness: total };
      await db.lacquers.put(toPlain(next));
      changed.push(next);
    }
  }
  return changed;
}
