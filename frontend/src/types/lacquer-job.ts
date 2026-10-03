/** 核销写入动作类型 */
export type LacquerJobKind = 'register-receipt' | 'resolve-seq' | 'reopen-seq' | 'remove-receipt';

/**
 * 核销链路的待落库动作。
 * IndexedDB 写入失败时保留已核销位置（动作快照），可重试或放弃；动作均幂等，
 * 重放不会重复新增遍次。成功执行后删除。
 */
export interface LacquerJob {
  id: string;
  kind: LacquerJobKind;
  createdAt: string;
  lastError: string;
  attempts: number;
  /** register-receipt 的载荷（已脱代理） */
  receipt?: unknown;
  /** resolve-seq / reopen-seq / remove-receipt 的定位与选择 */
  guqinNo?: string;
  seq?: number;
  receiptId?: string;
  /** resolve-seq：取信 'local' | 'outsource' */
  basis?: 'local' | 'outsource';
}
