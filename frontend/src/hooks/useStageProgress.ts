import { computed } from 'vue';
import { useBoardStore } from '../stores/boardStore';
import { useChamberStore } from '../stores/chamberStore';
import { useLacquerStore } from '../stores/lacquerStore';
import { useReceiptStore } from '../stores/receiptStore';
import { useStringingStore } from '../stores/stringingStore';
import { effectiveCumulativeOf, grayBodyReady, openRowsOf } from '../utils/reconcile';

export type StageKey = 'select' | 'carve' | 'lacquer' | 'string';

export interface StageItem {
  key: StageKey;
  label: string;
  done: boolean;
  detail: string;
}

export interface StageProgress {
  guqinNo: string;
  species: string;
  stages: StageItem[];
  /** 阶段推进比（0~100） */
  ratio: number;
  /** 缺失项 */
  missing: string[];
  /** 可核销累计厚度（mm，未决遍次不计入） */
  cumulativeMm: number;
  /** 未决核销（待复核 / 遍次对不上）条数 */
  openRecon: number;
}

export const STAGE_LABELS: Record<StageKey, string> = {
  select: '选材',
  carve: '掏膛',
  lacquer: '灰胎',
  string: '上弦',
};

/**
 * 按选材/掏膛/灰胎/上弦计算每张琴的阶段推进比与缺失项。
 * 选材：面板与底板配对齐全；掏膛：有槽腹记录；
 * 灰胎：无未决核销且可核销累计厚度达标（未决遍次不参与累计）；
 * 上弦：有上弦记录，且不允许在灰胎核销未决时当作灰胎已完成。
 */
export function useStageProgress() {
  const boardStore = useBoardStore();
  const chamberStore = useChamberStore();
  const lacquerStore = useLacquerStore();
  const receiptStore = useReceiptStore();
  const stringingStore = useStringingStore();

  const guqinNos = computed(() => {
    const set = new Set<string>();
    boardStore.boards.forEach((b) => set.add(b.guqinNo));
    chamberStore.chambers.forEach((c) => set.add(c.guqinNo));
    lacquerStore.layers.forEach((l) => set.add(l.guqinNo));
    receiptStore.receipts.forEach((r) => set.add(r.guqinNo));
    stringingStore.stringings.forEach((s) => set.add(s.guqinNo));
    return Array.from(set).sort();
  });

  const progressList = computed<StageProgress[]>(() =>
    guqinNos.value.map((guqinNo) => {
      const boards = boardStore.boards.filter((b) => b.guqinNo === guqinNo);
      const panel = boards.find((b) => b.part === '面板');
      const base = boards.find((b) => b.part === '底板');
      const chamber = chamberStore.chambers.find((c) => c.guqinNo === guqinNo);
      const layers = lacquerStore.layers.filter((l) => l.guqinNo === guqinNo);
      const receipts = receiptStore.receipts.filter((r) => r.guqinNo === guqinNo);
      const total = effectiveCumulativeOf(guqinNo, lacquerStore.layers, receiptStore.receipts);
      const openRows = openRowsOf(guqinNo, lacquerStore.layers, receiptStore.receipts);
      const ready = grayBodyReady(guqinNo, lacquerStore.layers, receiptStore.receipts);
      const stringing = stringingStore.stringings.find((s) => s.guqinNo === guqinNo);
      const species = panel?.species ?? base?.species ?? '';

      const lacquerDetail = ready
        ? `${layers.length} 遍核销累计 ${total.toFixed(2)}mm，灰胎完工`
        : openRows.length
          ? `${openRows.length} 遍核销未决，可核销累计 ${total.toFixed(2)}mm（未决不计入）`
          : layers.length
            ? `${layers.length} 遍，可核销累计 ${total.toFixed(2)}mm / 目标 1.00mm`
            : '尚未髹漆';

      const stages: StageItem[] = [
        {
          key: 'select',
          label: STAGE_LABELS.select,
          done: Boolean(panel && base),
          detail: panel && base ? `${panel.species}面板 + ${base.species}底板，阴干 ${Math.max(panel.dryYears, base.dryYears)} 年` : '面板或底板缺失',
        },
        {
          key: 'carve',
          label: STAGE_LABELS.carve,
          done: Boolean(chamber),
          detail: chamber ? `槽腹 ${chamber.chamberDepth}mm，纳音 ${chamber.nayinThickness}mm` : '尚未掏膛',
        },
        {
          key: 'lacquer',
          label: STAGE_LABELS.lacquer,
          done: ready,
          detail: lacquerDetail,
        },
        {
          key: 'string',
          label: STAGE_LABELS.string,
          // 有上弦记录且灰胎核销已完工才算完成；核销未决时不能把上弦当成灰胎完成的信号
          done: Boolean(stringing) && ready,
          detail: stringing
            ? ready
              ? `${stringing.stringType}，弦距 ${stringing.stringGap}mm`
              : '已上弦，但灰胎核销未决，不计完工'
            : '尚未上弦',
        },
      ];

      const doneCount = stages.filter((s) => s.done).length;
      return {
        guqinNo,
        species,
        stages,
        ratio: Math.round((doneCount / stages.length) * 100),
        missing: stages.filter((s) => !s.done).map((s) => s.label),
        cumulativeMm: Number(total.toFixed(2)),
        openRecon: openRows.length,
      };
    }),
  );

  const summary = computed(() => {
    const base: Record<StageKey, number> = { select: 0, carve: 0, lacquer: 0, string: 0 };
    progressList.value.forEach((item) => {
      item.stages.forEach((stage) => {
        if (stage.done) base[stage.key] += 1;
      });
    });
    const total = progressList.value.length || 1;
    return {
      counts: base,
      total: progressList.value.length,
      completed: progressList.value.filter((item) => item.ratio === 100).length,
      averageRatio: Math.round(progressList.value.reduce((sum, item) => sum + item.ratio, 0) / total),
    };
  });

  return { progressList, summary, guqinNos };
}
