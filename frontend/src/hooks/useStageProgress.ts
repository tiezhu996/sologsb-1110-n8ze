import { computed } from 'vue';
import { useBoardStore } from '../stores/boardStore';
import { useChamberStore } from '../stores/chamberStore';
import { useLacquerStore } from '../stores/lacquerStore';
import { useStringingStore } from '../stores/stringingStore';
import { buildRows, isSettled, settledTotal } from '../utils/reconcile';
import { LACQUER_STAGE_TARGET_MM } from '../utils/layer';

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
  cumulativeMm: number;
}

export const STAGE_LABELS: Record<StageKey, string> = {
  select: '选材',
  carve: '掏膛',
  lacquer: '灰胎',
  string: '上弦',
};

/**
 * 按选材/掏膛/灰胎/上弦计算每张琴的阶段推进比与缺失项。
 * 选材：面板与底板配对齐全；掏膛：有槽腹记录；灰胎：累计厚度达标；上弦：有上弦记录。
 */
export function useStageProgress() {
  const boardStore = useBoardStore();
  const chamberStore = useChamberStore();
  const lacquerStore = useLacquerStore();
  const stringingStore = useStringingStore();

  const guqinNos = computed(() => {
    const set = new Set<string>();
    boardStore.boards.forEach((b) => set.add(b.guqinNo));
    chamberStore.chambers.forEach((c) => set.add(c.guqinNo));
    lacquerStore.layers.forEach((l) => set.add(l.guqinNo));
    lacquerStore.receipts.forEach((r) => set.add(r.guqinNo));
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
      const receipts = lacquerStore.receipts.filter((r) => r.guqinNo === guqinNo);
      const rows = buildRows(layers, receipts);
      const total = settledTotal(layers, receipts);
      const pendingRows = rows.filter((r) => !isSettled(r.state));
      const settledCount = rows.filter((r) => isSettled(r.state) && r.layer).length;
      const stringing = stringingStore.stringings.find((s) => s.guqinNo === guqinNo);
      const species = panel?.species ?? base?.species ?? '';

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
          // 未决遍次不参与累计；有待复核遍次时灰胎不得视为完成，上弦环节也不会放行
          done: pendingRows.length === 0 && total >= LACQUER_STAGE_TARGET_MM,
          detail: pendingRows.length
            ? `${settledCount} 遍已核销，累计 ${total.toFixed(2)}mm；${pendingRows.length} 遍待复核，未计入`
            : rows.length
              ? `${settledCount} 遍，累计 ${total.toFixed(2)}mm / 目标 ${LACQUER_STAGE_TARGET_MM}mm`
              : '尚未髹漆',
        },
        {
          key: 'string',
          label: STAGE_LABELS.string,
          done: Boolean(stringing),
          detail: stringing ? `${stringing.stringType}，弦距 ${stringing.stringGap}mm` : '尚未上弦',
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
