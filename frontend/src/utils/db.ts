import Dexie, { type Table } from 'dexie';
import type { WoodBoard } from '../types/wood-board';
import type { SoundChamber } from '../types/sound-chamber';
import type { LacquerLayer } from '../types/lacquer-layer';
import type { Stringing } from '../types/stringing';
import type { OutsourcedReceipt } from '../types/outsourced';

/** IndexedDB 库名（浏览器本地存储，无后端） */
export const DB_NAME = 'gbguqin-db';

/** 当前 schema 版本，与 db.version(n) 对应 */
export const SCHEMA_VERSION = 3;

class GuqinDB extends Dexie {
  boards!: Table<WoodBoard, string>;
  chambers!: Table<SoundChamber, string>;
  lacquers!: Table<LacquerLayer, string>;
  receipts!: Table<OutsourcedReceipt, string>;
  stringings!: Table<Stringing, string>;
  meta!: Table<{ key: string; value: string }, string>;

  constructor() {
    super(DB_NAME);

    // v1：建表声明索引
    this.version(1).stores({
      boards: 'id, boardNo, guqinNo, part, species, grain, receivedAt',
      chambers: 'id, guqinNo, postPos, carvedAt',
      lacquers: 'id, guqinNo, seq, appliedAt',
      stringings: 'id, guqinNo, stringType, strungAt',
      meta: 'key',
    });

    // v2：髹漆表增加 (guqinNo+seq) 复合索引，便于按遍次排序查询；并回填历史 layerThickness。
    // 升级前请在顶栏「导出备份」导出 JSON。
    this.version(2)
      .stores({
        boards: 'id, boardNo, guqinNo, part, species, grain, receivedAt',
        chambers: 'id, guqinNo, postPos, carvedAt',
        lacquers: 'id, guqinNo, seq, [guqinNo+seq], appliedAt',
        stringings: 'id, guqinNo, stringType, strungAt',
        meta: 'key',
      })
      .upgrade(async (tx) => {
        await tx
          .table('lacquers')
          .toCollection()
          .modify((row: LacquerLayer) => {
            if (!row.layerThickness && row.totalThickness) {
              row.layerThickness = row.totalThickness;
            }
          });
      });

    // v3：新增外协漆坊施工回执表（与本坊遍次两套来源，按琴号+遍次核销）。
    // lacquers 表不加列声明（IndexedDB 无列概念），source/核销字段随记录自然出现；
    // 历史遍次缺 source 标记时按本坊记录兼容。
    this.version(3).stores({
      boards: 'id, boardNo, guqinNo, part, species, grain, receivedAt',
      chambers: 'id, guqinNo, postPos, carvedAt',
      lacquers: 'id, guqinNo, seq, [guqinNo+seq], appliedAt',
      receipts: 'id, receiptNo, guqinNo, seq, status, receivedAt',
      stringings: 'id, guqinNo, stringType, strungAt',
      meta: 'key',
    });
  }
}

export const db = new GuqinDB();

export async function getMeta(key: string): Promise<string | undefined> {
  const row = await db.meta.get(key);
  return row?.value;
}

export async function setMeta(key: string, value: string): Promise<void> {
  await db.meta.put({ key, value });
}
