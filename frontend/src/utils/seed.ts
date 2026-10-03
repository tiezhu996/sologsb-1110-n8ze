import { db } from './db';
import type { WoodBoard } from '../types/wood-board';
import type { SoundChamber } from '../types/sound-chamber';
import type { LacquerLayer } from '../types/lacquer-layer';
import type { LacquerReceipt } from '../types/lacquer-receipt';
import type { Stringing } from '../types/stringing';
import { rowsOfGuqin, withSettledCumulative } from './reconcile';

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

/** 示例琴坯：5 张琴、10 块板材 */
export const SEED_BOARDS: WoodBoard[] = [
  { id: 'board-001', boardNo: 'MB-2501', guqinNo: 'Q-2501', part: '面板', species: '桐木', dryYears: 8, thicknessMm: 32, grain: '直纹', defect: '无', receivedAt: daysAgo(120), remark: '河南兰考桐' },
  { id: 'board-002', boardNo: 'MB-2502', guqinNo: 'Q-2501', part: '底板', species: '梓木', dryYears: 6, thicknessMm: 18, grain: '直纹', defect: '无', receivedAt: daysAgo(118) },
  { id: 'board-003', boardNo: 'MB-2503', guqinNo: 'Q-2502', part: '面板', species: '杉木', dryYears: 12, thicknessMm: 30, grain: '水波纹', defect: '无', receivedAt: daysAgo(110), remark: '川杉，纹路佳' },
  { id: 'board-004', boardNo: 'MB-2504', guqinNo: 'Q-2502', part: '底板', species: '梓木', dryYears: 7, thicknessMm: 17, grain: '直纹', defect: '节疤', receivedAt: daysAgo(108) },
  { id: 'board-005', boardNo: 'MB-2505', guqinNo: 'Q-2503', part: '面板', species: '桐木', dryYears: 5, thicknessMm: 31, grain: '直纹', defect: '无', receivedAt: daysAgo(96) },
  { id: 'board-006', boardNo: 'MB-2506', guqinNo: 'Q-2503', part: '底板', species: '杉木', dryYears: 5, thicknessMm: 18, grain: '直纹', defect: '无', receivedAt: daysAgo(95) },
  { id: 'board-007', boardNo: 'MB-2507', guqinNo: 'Q-2504', part: '面板', species: '杉木', dryYears: 15, thicknessMm: 33, grain: '水波纹', defect: '无', receivedAt: daysAgo(80), remark: '老房料' },
  { id: 'board-008', boardNo: 'MB-2508', guqinNo: 'Q-2504', part: '底板', species: '梓木', dryYears: 9, thicknessMm: 19, grain: '直纹', defect: '无', receivedAt: daysAgo(78) },
  { id: 'board-009', boardNo: 'MB-2509', guqinNo: 'Q-2505', part: '面板', species: '桐木', dryYears: 2, thicknessMm: 29, grain: '直纹', defect: '裂纹', receivedAt: daysAgo(30), remark: '阴干不足且有裂纹，待退料' },
  { id: 'board-010', boardNo: 'MB-2510', guqinNo: 'Q-2505', part: '底板', species: '梓木', dryYears: 4, thicknessMm: 17, grain: '直纹', defect: '无', receivedAt: daysAgo(28) },
];

export const SEED_CHAMBERS: SoundChamber[] = [
  { id: 'chamber-001', guqinNo: 'Q-2501', nayinThickness: 16, longchiThickness: 14, fengzhaoThickness: 15, chamberDepth: 26, postPos: '天柱中', poolSize: '200×22', carvedAt: daysAgo(88), carver: '周砚秋', remark: '纳音略厚，出音偏沉' },
  { id: 'chamber-002', guqinNo: 'Q-2502', nayinThickness: 14, longchiThickness: 12, fengzhaoThickness: 13, chamberDepth: 28, postPos: '天柱偏左', poolSize: '210×24', carvedAt: daysAgo(76), carver: '周砚秋' },
  { id: 'chamber-003', guqinNo: 'Q-2503', nayinThickness: 15, longchiThickness: 13, fengzhaoThickness: 14, chamberDepth: 25, postPos: '天柱偏右', poolSize: '195×21', carvedAt: daysAgo(60), carver: '林听雪' },
  { id: 'chamber-004', guqinNo: 'Q-2504', nayinThickness: 17, longchiThickness: 15, fengzhaoThickness: 16, chamberDepth: 24, postPos: '天柱中', poolSize: '215×25', carvedAt: daysAgo(44), carver: '林听雪', remark: '老料槽腹留厚' },
];

function buildSeedLayers(): LacquerLayer[] {
  // 历史遍次大多不带 source（由 v3 升级/读取按本坊兼容）；仅明确的外协遍打标。
  const plan: Array<[string, string, number, number, number, number, number, string, LacquerLayer['source'], LacquerLayer['reconcileState']?]> = [
    // guqinNo, mixRatio, temp, humidity, grit, thicknessMm, daysAgo, operator, source, reconcile
    ['Q-2501', '1:1', 24, 78, 240, 0.12, 70, '林听雪', undefined],
    ['Q-2501', '1:1', 25, 80, 320, 0.1, 58, '林听雪', undefined],
    ['Q-2501', '1:1.2', 26, 82, 400, 0.09, 40, '林听雪', undefined],
    ['Q-2502', '1:1', 23, 76, 240, 0.13, 62, '林听雪', undefined],
    ['Q-2502', '1:1.5', 27, 84, 400, 0.11, 45, '周砚秋', undefined],
    ['Q-2502', '1:1.5', 25, 80, 600, 0.08, 30, '周砚秋', undefined],
    ['Q-2503', '1:1.2', 22, 74, 240, 0.12, 48, '林听雪', undefined],
    ['Q-2503', '1:1.2', 26, 82, 400, 0.1, 33, '林听雪', undefined],
    ['Q-2504', '1:1', 24, 79, 320, 0.12, 36, '周砚秋', undefined],
    ['Q-2504', '1:1.5', 28, 85, 600, 0.09, 21, '周砚秋', undefined],
    ['Q-2501', '1:2', 18, 65, 800, 0.05, 18, '林听雪', undefined],
    ['Q-2502', '纯生漆', 24, 70, 1000, 0.04, 12, '周砚秋', undefined],
    // Q-2503 第 3 遍交外协，回执与本坊一致，已采用外协值核销
    ['Q-2503', '1:1.5', 25, 80, 600, 0.11, 20, '徽城漆坊', 'outsource', 'resolved-outsource'],
    // Q-2504 第 3 遍交外协，回执厚度/日期与本坊不符，待复核（不计入累计）
    ['Q-2504', '1:1.5', 25, 80, 600, 0.11, 10, '周砚秋', undefined, 'disputed'],
  ];

  const seqMap = new Map<string, number>();
  return plan.map(([guqinNo, mixRatio, temp, humidity, grit, thickness, days, operator, source, reconcile], index) => {
    const seq = (seqMap.get(guqinNo) ?? 0) + 1;
    seqMap.set(guqinNo, seq);
    return {
      id: `layer-${String(index + 1).padStart(3, '0')}`,
      guqinNo,
      seq,
      ...(source ? { source } : {}),
      ...(reconcile ? { reconcileState: reconcile } : {}),
      ...(reconcile === 'resolved-outsource' ? { receiptId: `receipt-${String(index + 1).padStart(3, '0')}` } : {}),
      mixRatio,
      curingTemp: temp,
      curingHumidity: humidity,
      polishGrit: grit,
      layerThickness: thickness,
      totalThickness: 0,
      appliedAt: daysAgo(days),
      operator,
    };
  });
}

/** 外协漆坊回执示例：一致、冲突、重复送达、孤儿回执（本坊无此遍）各一 */
function buildSeedReceipts(layers: LacquerLayer[]): LacquerReceipt[] {
  const at = (layer: LacquerLayer | undefined) => layer?.appliedAt ?? new Date().toISOString();
  const find = (guqinNo: string, seq: number) => layers.find((l) => l.guqinNo === guqinNo && l.seq === seq);
  const make = (
    id: string,
    receiptNo: string,
    workshop: string,
    batchNo: string,
    guqinNo: string,
    seq: number,
    thickness: number,
    mixRatio: string,
    appliedAt: string,
    mergedCount = 0,
    operator?: string,
  ): LacquerReceipt => ({
    id,
    receiptNo,
    workshop,
    localBatchNo: batchNo,
    guqinNo,
    seq,
    layerThickness: thickness,
    mixRatio,
    appliedAt,
    receivedAt: daysAgo(8),
    mergedCount,
    lastReceivedAt: daysAgo(mergedCount ? 2 : 8),
    ...(operator ? { operator } : {}),
  });

  return [
    // Q-2503 第 3 遍：与本坊记录一致（0.11 / 1:1.5），已核销采用外协值
    make('receipt-013', 'WX-3301', '徽城漆坊', 'DB-7781', 'Q-2503', 3, 0.11, '1:1.5', at(find('Q-2503', 3)), 1, '徽城漆坊'),
    // Q-2504 第 3 遍：回执厚度 0.15、日期早一天，与本坊 0.11 冲突，待复核
    make('receipt-014', 'WX-4402', '徽城漆坊', 'DB-7790', 'Q-2504', 3, 0.15, '1:1.5', daysAgo(9), 0, '徽城漆坊'),
    // Q-2501 第 4 遍：本坊已做（0.05），外协也送来一张同遍回执（0.06），且重复送达一次
    make('receipt-011', 'WX-1104', "婺源永胜漆坊", 'DB-7802', 'Q-2501', 4, 0.06, '1:2', at(find('Q-2501', 4)), 1, '永胜漆坊'),
    // 孤儿回执：Q-2505 第 1 遍只有外协回执，本坊遍次尚未入册
    make('receipt-015', 'WX-5501', '徽城漆坊', 'DB-7810', 'Q-2505', 1, 0.13, '1:1', daysAgo(6), 0, '徽城漆坊'),
  ];
}

/** 重新计算每张琴的累计厚度：未决遍次不参与累计，并沿用上一已核销遍累计值 */
export function withCumulative(layers: LacquerLayer[], receipts: LacquerReceipt[] = []): LacquerLayer[] {
  const guqinSet = new Set(layers.map((l) => l.guqinNo));
  let result = new Map<string, LacquerLayer>();
  layers.forEach((l) => result.set(l.id, l));
  Array.from(guqinSet)
    .sort()
    .forEach((guqinNo) => {
      const rows = rowsOfGuqin(
        layers.filter((l) => l.guqinNo === guqinNo),
        receipts.filter((r) => r.guqinNo === guqinNo),
        guqinNo,
      );
      withSettledCumulative(rows).forEach((l) => result.set(l.id, l));
    });
  return layers.map((l) => result.get(l.id) ?? l);
}

export const SEED_STRINGINGS: Stringing[] = [
  {
    id: 'stringing-001',
    guqinNo: 'Q-2501',
    stringType: '丝弦',
    nut: '红木雁足 + 丝绒扣',
    stringGap: 17,
    sanNote: '散音宽厚，一弦如钟，七弦略紧需再养。',
    anNote: '按音走手顺滑，九徽以下音色沉静，无抗指。',
    fanNote: '泛音清亮，五六徽尤其干净。',
    nineVirtues: '奇、古、透、静、润佳；圆、匀稍欠，清、芳待养。',
    defects: ['无'],
    strungAt: daysAgo(10),
    operator: '周砚秋',
    noteVersions: [],
  },
  {
    id: 'stringing-002',
    guqinNo: 'Q-2502',
    stringType: '钢弦',
    nut: '乌木雁足 + 尼龙扣',
    stringGap: 18,
    sanNote: '散音亮而略噪，钢弦本性使然。',
    anNote: '按音清越，四弦七徽处有轻微沙音。',
    fanNote: '泛音通透，尤以三徽为最。',
    nineVirtues: '透、清、亮为主；古、静不足。',
    defects: ['沙音'],
    strungAt: daysAgo(6),
    operator: '林听雪',
    noteVersions: [],
  },
  {
    id: 'stringing-003',
    guqinNo: 'Q-2503',
    stringType: '丝弦',
    nut: '红木雁足 + 丝绒扣',
    stringGap: 17,
    sanNote: '散音均匀，五弦稍闷。',
    anNote: '按音圆润，走弦无声，宜弹文曲。',
    fanNote: '泛音圆而不散。',
    nineVirtues: '圆、润、匀见长；透、芳尚需时日。',
    defects: ['无'],
    strungAt: daysAgo(3),
    operator: '林听雪',
    noteVersions: [
      { id: 'tv-001', savedAt: daysAgo(3), sanNote: '散音初上，音色紧。', anNote: '按音略抗指。', fanNote: '泛音偏闷。', nineVirtues: '新弦未开。' },
    ],
  },
];

/** 首次打开（表内无数据）时写入示例数据；已有数据则不动 */
export async function seedIfEmpty(): Promise<void> {
  const flag = await db.meta.get('seeded');
  if (flag) {
    return;
  }
  const [boardCount, chamberCount, lacquerCount, receiptCount, stringingCount] = await Promise.all([
    db.boards.count(),
    db.chambers.count(),
    db.lacquers.count(),
    db.lacquerReceipts.count(),
    db.stringings.count(),
  ]);
  const rawLayers = buildSeedLayers();
  const receipts = buildSeedReceipts(rawLayers);
  const layers = withCumulative(rawLayers, receipts);

  await db.transaction(
    'rw',
    [db.boards, db.chambers, db.lacquers, db.lacquerReceipts, db.stringings, db.meta],
    async () => {
      if (boardCount === 0) await db.boards.bulkPut(SEED_BOARDS);
      if (chamberCount === 0) await db.chambers.bulkPut(SEED_CHAMBERS);
      if (lacquerCount === 0) await db.lacquers.bulkPut(layers);
      if (receiptCount === 0) await db.lacquerReceipts.bulkPut(receipts);
      if (stringingCount === 0) await db.stringings.bulkPut(SEED_STRINGINGS);
      await db.meta.put({ key: 'seeded', value: new Date().toISOString() });
    },
  );
}
