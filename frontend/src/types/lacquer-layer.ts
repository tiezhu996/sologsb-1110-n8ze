/** 灰胎遍次来源：本坊自做 / 外协漆坊回执（缺省按本坊记录兼容） */
export type LayerSource = 'local' | 'outsource';

/**
 * 对账结论（落库部分）。
 * - 无标记或 disputed：尚未决；matched 由本坊值与回执值实时比对派生，不落库；
 * - resolved-local：维持本坊值；resolved-outsource：采用外协值。
 */
export type LayerReconcileState = 'disputed' | 'resolved-local' | 'resolved-outsource';

/** 核销取信一方的旧值快照（旧值仍可查阅） */
export interface LayerValueSnapshot {
  id: string;
  savedAt: string;
  /** 该快照记录的是哪一方的值 */
  basis: 'local' | 'outsource';
  /** 外协回执号（basis=outsource 时） */
  receiptNo?: string;
  mixRatio: string;
  layerThickness: number;
  appliedAt: string;
}

/** 灰胎髹漆遍次 */
export interface LacquerLayer {
  id: string;
  /** 琴号 */
  guqinNo: string;
  /** 遍次（从 1 开始，追加时自动 +1） */
  seq: number;
  /** 来源：本坊 / 外协；历史记录缺省 undefined，按本坊记录兼容 */
  source?: LayerSource;
  /**
   * 对账状态：
   * undefined 表示无争议（本坊单方记录，或与回执一致）；
   * disputed 为待复核；resolved-* 为已核销取信一方。
   */
  reconcileState?: LayerReconcileState;
  /** 采用外协值时关联的回执 id */
  receiptId?: string;
  /** 历次核销保留的旧值（最新在前） */
  valueHistory?: LayerValueSnapshot[];
  /** 灰胎配比（鹿角霜:生漆） */
  mixRatio: string;
  /** 荫房温度（℃） */
  curingTemp: number;
  /** 荫房湿度（%） */
  curingHumidity: number;
  /** 打磨目数 */
  polishGrit: number;
  /** 本遍厚度（mm） */
  layerThickness: number;
  /** 累计厚度（mm），仅累计已核销遍次；未决遍次取上一已核销遍的累计值 */
  totalThickness: number;
  /** 施工日期 ISO */
  appliedAt: string;
  /** 髹漆人 */
  operator: string;
  /** 备注 */
  remark?: string;
}

/** 灰胎阶段常用配比 */
export const MIX_RATIOS: string[] = ['1:1', '1:1.2', '1:1.5', '1:2', '纯生漆'];
