import type { LayerSource, Resolution } from './outsourced';

/** 待复核裁决时留存的旧值快照（采用外协值后，本坊旧值仍可查阅） */
export interface LayerSnapshot {
  savedAt: string;
  resolution: Resolution;
  receiptNo?: string;
  layerThickness: number;
  mixRatio: string;
  appliedAt: string;
}

/** 灰胎髹漆遍次 */
export interface LacquerLayer {
  id: string;
  /** 琴号 */
  guqinNo: string;
  /** 遍次（从 1 开始，追加时自动 +1） */
  seq: number;
  /** 来源：本坊 / 外协；历史记录缺字段按本坊记录兼容 */
  source?: LayerSource;
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
  /** 累计厚度（mm），由本遍及之前各遍可核销遍次累加；未决遍次不计入 */
  totalThickness: number;
  /** 施工日期 ISO */
  appliedAt: string;
  /** 髹漆人 */
  operator: string;
  /** 备注 */
  remark?: string;
  /** 最近一次核销回执单号 */
  reconciledReceiptNo?: string;
  /** 最近一次核销时间 ISO */
  reconciledAt?: string;
  /** 待复核裁决方式（裁决后该遍即视为已核销） */
  resolution?: Resolution;
  /** 裁决时认定的回执侧值指纹（回执再被改成不一致则自动回到待复核） */
  resolvedFingerprint?: string;
  /** 历次裁决前的本坊旧值快照（最新在前） */
  snapshots?: LayerSnapshot[];
}

/** 灰胎阶段常用配比 */
export const MIX_RATIOS: string[] = ['1:1', '1:1.2', '1:1.5', '1:2', '纯生漆'];
