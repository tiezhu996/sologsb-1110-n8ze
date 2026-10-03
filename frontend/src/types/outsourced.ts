/** 髹漆遍次来源：本坊自髹 / 外协漆坊；历史记录缺字段时按本坊记录兼容 */
export type LayerSource = 'local' | 'outsourced';

/** 待复核裁决方式：采用外协回执值 / 保留本坊记录值 */
export type Resolution = 'receipt' | 'local';

/** 外协施工回执状态：在途 / 中途退出 */
export type ReceiptStatus = 'active' | 'withdrawn';

/** 外协漆坊回传的灰胎施工回执（与本地髹漆遍次分属两套来源） */
export interface OutsourcedReceipt {
  id: string;
  /** 回执单号（外协漆坊回传；同号重复送达不新增） */
  receiptNo: string;
  /** 地方批号（外协自编号，常与本坊琴号遍次对不上） */
  batchNo: string;
  /** 本坊核销时认定的琴号 */
  guqinNo: string;
  /** 回执对应的遍次 */
  seq: number;
  /** 回执填报本遍厚度（mm） */
  layerThickness: number;
  /** 回执填报灰胎配比 */
  mixRatio: string;
  /** 回执填报施工日期 ISO */
  appliedAt: string;
  /** 外协漆坊 / 施工人 */
  workshop: string;
  status: ReceiptStatus;
  /** 回执送达本坊时间 ISO */
  receivedAt: string;
  remark?: string;
}

/** 对账结果 */
export type ReconStatus =
  | 'reconciled' // 本坊与回执一致，或差异已经裁决
  | 'disputed' // 双方都有，厚度/配比/施工日期不一致，待复核
  | 'pending-local' // 仅本坊有遍次，回执未到
  | 'pending-receipt' // 仅回执有（地方批号/遍次对不上），待复核
  | 'withdrawn'; // 回执中途退出，以本坊记录为准

/** 双方不一致的字段 */
export type DiffField = 'layerThickness' | 'mixRatio' | 'appliedAt';

export const DIFF_LABELS: Record<DiffField, string> = {
  layerThickness: '厚度',
  mixRatio: '配比',
  appliedAt: '施工日期',
};

export const RECON_STATUS_LABELS: Record<ReconStatus, string> = {
  reconciled: '已核销',
  disputed: '待复核',
  'pending-local': '回执未到',
  'pending-receipt': '遍次对不上',
  withdrawn: '外协已退出',
};

export const RECEIPT_STATUS_LABELS: Record<ReceiptStatus, string> = {
  active: '在途',
  withdrawn: '中途退出',
};

export const RESOLUTION_LABELS: Record<Resolution, string> = {
  receipt: '采用外协值',
  local: '保留本坊值',
};
