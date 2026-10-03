/** 外协漆坊灰胎施工回执（独立来源，不直接计入遍次，须按琴号+遍次对账核销） */
export interface LacquerReceipt {
  id: string;
  /** 回执单号（外协坊自编号，可能缺号或与本坊对不上） */
  receiptNo: string;
  /** 外协漆坊名称 */
  workshop: string;
  /** 外协坊自己的地方批号 */
  localBatchNo: string;
  /** 琴号（对账主键之一） */
  guqinNo: string;
  /** 遍次（对账主键之一；外协中途退出时可能只送到某一遍） */
  seq: number;
  /** 回执填报厚度（mm） */
  layerThickness: number;
  /** 回执填报配比 */
  mixRatio: string;
  /** 回执施工日期 ISO */
  appliedAt: string;
  /** 回执温度/湿度/目数（外协常缺测，允许为空） */
  curingTemp?: number;
  curingHumidity?: number;
  polishGrit?: number;
  /** 回执经手人 */
  operator?: string;
  remark?: string;
  /** 首次送达时间 */
  receivedAt: string;
  /** 同一张回执重复送达次数（重复回执不新增遍次，只累加并更新最近送达时间） */
  mergedCount: number;
  /** 最近一次送达时间 */
  lastReceivedAt: string;
}

export interface LacquerReceiptInput {
  receiptNo: string;
  workshop: string;
  localBatchNo: string;
  guqinNo: string;
  seq: number;
  layerThickness: number;
  mixRatio: string;
  appliedAt?: string;
  curingTemp?: number;
  curingHumidity?: number;
  polishGrit?: number;
  operator?: string;
  remark?: string;
}
