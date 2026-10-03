<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import StatBadge from '../components/common/StatBadge.vue';
import LayerStack from '../components/common/LayerStack.vue';
import EmptyPanel from '../components/common/EmptyPanel.vue';
import { useLacquerStore } from '../stores/lacquerStore';
import { useBoardStore } from '../stores/boardStore';
import { averageThickness, curingInRange, formatDate, layersToTarget, TARGET_TOTAL_MM } from '../utils/layer';
import { rowIncluded, type LacquerRow, type RowState } from '../utils/reconcile';
import { MIX_RATIOS, type LacquerLayer, type LayerValueSnapshot } from '../types/lacquer-layer';
import type { LacquerReceipt } from '../types/lacquer-receipt';
import type { LacquerJob } from '../types/lacquer-job';

const lacquerStore = useLacquerStore();
const boardStore = useBoardStore();

const guqinOptions = computed(() =>
  Array.from(new Set([...boardStore.guqinNos, ...lacquerStore.guqinNos])).sort(),
);
const selectedGuqin = ref(guqinOptions.value[0] ?? '');
watch(guqinOptions, (list) => {
  if (!selectedGuqin.value && list.length) {
    selectedGuqin.value = list[0];
  }
});

/** 按琴号+遍次对过账的行（本坊遍次 × 外协回执） */
const rows = computed<LacquerRow[]>(() => (selectedGuqin.value ? lacquerStore.rowsOf(selectedGuqin.value) : []));
const settledLayers = computed(() =>
  rows.value.filter(rowIncluded).map((r) => r.layer).filter((l): l is LacquerLayer => Boolean(l)),
);
const total = computed(() => (selectedGuqin.value ? lacquerStore.totalOf(selectedGuqin.value) : 0));
const pending = computed(() => rows.value.filter((r) => !rowIncluded(r)).length);
const abnormal = computed(
  () =>
    settledLayers.value.filter((layer) => !curingInRange(layer.curingTemp, layer.curingHumidity)).length,
);

const STATE_TAG: Record<RowState, { text: string; type: 'success' | 'info' | 'warning' | 'danger' | 'primary' }> = {
  'local-only': { text: '本坊', type: 'info' },
  matched: { text: '已对平', type: 'success' },
  disputed: { text: '待复核', type: 'danger' },
  'resolved-local': { text: '已核销·本坊', type: 'success' },
  'resolved-outsource': { text: '已核销·外协', type: 'primary' },
  'receipt-only': { text: '仅回执', type: 'warning' },
};

const JOB_KIND_TEXT: Record<LacquerJob['kind'], string> = {
  'register-receipt': '登记回执',
  'resolve-seq': '核销遍次',
  'reopen-seq': '重新对账',
  'remove-receipt': '删除回执',
};

// ---------- 本坊遍次对话框 ----------
const layerDialogVisible = ref(false);
const editingId = ref('');
const layerFormRef = ref<FormInstance>();

interface LacquerForm {
  guqinNo: string;
  mixRatio: string;
  curingTemp: number;
  curingHumidity: number;
  polishGrit: number;
  layerThickness: number;
  appliedAt: string;
  operator: string;
  remark: string;
}

const emptyLayerForm = (): LacquerForm => ({
  guqinNo: selectedGuqin.value || guqinOptions.value[0] || 'Q-2501',
  mixRatio: '1:1',
  curingTemp: 25,
  curingHumidity: 78,
  polishGrit: 320,
  layerThickness: 0.1,
  appliedAt: new Date().toISOString().slice(0, 10),
  operator: '林听雪',
  remark: '',
});
const layerForm = ref<LacquerForm>(emptyLayerForm());

const layerRules: FormRules = {
  guqinNo: [{ required: true, message: '请输入琴号', trigger: 'blur' }],
  operator: [{ required: true, message: '请输入髹漆人', trigger: 'blur' }],
};

function openAppend() {
  editingId.value = '';
  layerForm.value = emptyLayerForm();
  layerDialogVisible.value = true;
}

function openEdit(row: LacquerRow) {
  if (!row.layer) return;
  editingId.value = row.layer.id;
  layerForm.value = {
    guqinNo: row.layer.guqinNo,
    mixRatio: row.layer.mixRatio,
    curingTemp: row.layer.curingTemp,
    curingHumidity: row.layer.curingHumidity,
    polishGrit: row.layer.polishGrit,
    layerThickness: row.layer.layerThickness,
    appliedAt: row.layer.appliedAt.slice(0, 10),
    operator: row.layer.operator,
    remark: row.layer.remark ?? '',
  };
  layerDialogVisible.value = true;
}

async function submitLayer() {
  const ok = await layerFormRef.value?.validate().catch(() => false);
  if (!ok) return;
  const payload = {
    guqinNo: layerForm.value.guqinNo,
    mixRatio: layerForm.value.mixRatio,
    curingTemp: Number(layerForm.value.curingTemp) || 0,
    curingHumidity: Number(layerForm.value.curingHumidity) || 0,
    polishGrit: Number(layerForm.value.polishGrit) || 0,
    layerThickness: Number(layerForm.value.layerThickness) || 0,
    appliedAt: new Date(`${layerForm.value.appliedAt}T09:00:00`).toISOString(),
    operator: layerForm.value.operator,
    remark: layerForm.value.remark,
  };
  try {
    if (editingId.value) {
      await lacquerStore.updateLayer(editingId.value, payload);
      ElMessage.success('已更新该遍记录并重算累计厚度');
    } else {
      const created = await lacquerStore.appendLayer(payload);
      selectedGuqin.value = created.guqinNo;
      ElMessage.success(`已追加第 ${created.seq} 遍（本坊），累计厚度 ${created.totalThickness.toFixed(2)}mm`);
    }
    layerDialogVisible.value = false;
  } catch (error) {
    ElMessage.error(`写入失败：${(error as Error).message}，请重试`);
  }
}

async function removeLayer(row: LacquerRow) {
  if (!row.layer) return;
  const confirmed = await ElMessageBox.confirm(
    `确认删除 ${row.layer.guqinNo} 第 ${row.layer.seq} 遍本坊记录？对应外协回执仍会保留。`,
    '删除确认',
    { type: 'warning' },
  )
    .then(() => true)
    .catch(() => false);
  if (!confirmed) return;
  try {
    await lacquerStore.removeLayer(row.layer.id);
    ElMessage.success('已删除并重算累计厚度');
  } catch (error) {
    ElMessage.error(`写入失败：${(error as Error).message}，请重试`);
  }
}

// ---------- 外协回执对话框 ----------
const receiptDialogVisible = ref(false);
const receiptFormRef = ref<FormInstance>();

interface ReceiptForm {
  receiptNo: string;
  workshop: string;
  localBatchNo: string;
  guqinNo: string;
  seq: number;
  layerThickness: number;
  mixRatio: string;
  appliedAt: string;
  curingTemp: number | null;
  curingHumidity: number | null;
  polishGrit: number | null;
  operator: string;
  remark: string;
}

const receiptForm = ref<ReceiptForm>({
  receiptNo: '',
  workshop: '徽城漆坊',
  localBatchNo: '',
  guqinNo: '',
  seq: 1,
  layerThickness: 0.1,
  mixRatio: '1:1',
  appliedAt: new Date().toISOString().slice(0, 10),
  curingTemp: null,
  curingHumidity: null,
  polishGrit: null,
  operator: '',
  remark: '',
});

const receiptRules: FormRules = {
  workshop: [{ required: true, message: '请填写外协漆坊', trigger: 'blur' }],
  localBatchNo: [{ required: true, message: '请填写地方批号', trigger: 'blur' }],
  guqinNo: [{ required: true, message: '请填写琴号', trigger: 'blur' }],
  seq: [{ required: true, message: '请填写遍次', trigger: 'blur' }],
};

function openReceipt(seqPreset?: number) {
  receiptForm.value = {
    receiptNo: '',
    workshop: '徽城漆坊',
    localBatchNo: '',
    guqinNo: selectedGuqin.value,
    seq: seqPreset ?? (rows.value.length ? Math.max(...rows.value.map((r) => r.seq)) + 1 : 1),
    layerThickness: 0.1,
    mixRatio: '1:1',
    appliedAt: new Date().toISOString().slice(0, 10),
    curingTemp: null,
    curingHumidity: null,
    polishGrit: null,
    operator: '',
    remark: '',
  };
  receiptDialogVisible.value = true;
}

async function submitReceipt() {
  const ok = await receiptFormRef.value?.validate().catch(() => false);
  if (!ok) return;
  const result = await lacquerStore.registerReceipt({
    receiptNo: receiptForm.value.receiptNo,
    workshop: receiptForm.value.workshop,
    localBatchNo: receiptForm.value.localBatchNo,
    guqinNo: receiptForm.value.guqinNo,
    seq: Number(receiptForm.value.seq),
    layerThickness: Number(receiptForm.value.layerThickness) || 0,
    mixRatio: receiptForm.value.mixRatio,
    appliedAt: new Date(`${receiptForm.value.appliedAt}T09:00:00`).toISOString(),
    curingTemp: receiptForm.value.curingTemp ?? undefined,
    curingHumidity: receiptForm.value.curingHumidity ?? undefined,
    polishGrit: receiptForm.value.polishGrit ?? undefined,
    operator: receiptForm.value.operator,
    remark: receiptForm.value.remark,
  });
  selectedGuqin.value = receiptForm.value.guqinNo;
  if (result.jobId) {
    ElMessage.warning('回执写入失败，已保留核销位置，可在页面顶部待处理任务中重试');
  } else if (result.duplicated) {
    ElMessage.success('同一回执重复送达：已合并送达次数，未新增遍次');
  } else {
    ElMessage.success('外协回执已登记，等待按琴号+遍次对账');
  }
  receiptDialogVisible.value = false;
}

// ---------- 对账核销动作 ----------
async function confirmResolve(row: LacquerRow, basis: 'local' | 'outsource') {
  const verb = basis === 'outsource' ? '采用外协回执值' : '维持本坊记录值';
  const confirmed = await ElMessageBox.confirm(
    `确认对 ${row.guqinNo} 第 ${row.seq} 遍${verb}？该遍及后续累计厚度、琴坯进度将立即失效重算，旧值仍可查阅。`,
    '核销确认',
    { type: 'warning', confirmButtonText: '确认核销' },
  )
    .then(() => true)
    .catch(() => false);
  if (!confirmed) return;
  const jobId = await lacquerStore.resolveSeq(row.guqinNo, row.seq, basis, row.receipt?.id);
  if (jobId) {
    ElMessage.warning('核销写入失败，已保留核销位置，可在页面顶部待处理任务中重试');
  } else {
    ElMessage.success(basis === 'outsource' ? '已采用外协值，累计厚度已重算' : '已按本坊值核销，累计厚度已重算');
  }
}

async function confirmReopen(row: LacquerRow) {
  const confirmed = await ElMessageBox.confirm(
    `重新打开 ${row.guqinNo} 第 ${row.seq} 遍的对账？该遍及后续累计将回到待复核状态并重算。`,
    '重新对账',
    { type: 'warning' },
  )
    .then(() => true)
    .catch(() => false);
  if (!confirmed) return;
  const jobId = await lacquerStore.reopenSeq(row.guqinNo, row.seq);
  ElMessage[jobId ? 'warning' : 'success'](
    jobId ? '写入失败，已保留待重试' : '已恢复待复核并按本坊旧值重算累计',
  );
}

async function removeReceipt(receipt: LacquerReceipt) {
  const confirmed = await ElMessageBox.confirm(
    `确认删除外协回执 ${receipt.receiptNo || `${receipt.workshop}/${receipt.localBatchNo}`}（${receipt.guqinNo} 第 ${receipt.seq} 遍）？`,
    '删除回执',
    { type: 'warning' },
  )
    .then(() => true)
    .catch(() => false);
  if (!confirmed) return;
  const jobId = await lacquerStore.removeReceipt(receipt.id);
  ElMessage[jobId ? 'warning' : 'success'](jobId ? '删除失败，已保留待重试' : '回执已删除，累计厚度已重算');
}

// ---------- 失败任务重试 ----------
async function retryJob(job: LacquerJob) {
  const ok = await lacquerStore.retryJob(job.id);
  if (ok) ElMessage.success('核销任务已重试成功');
  else ElMessage.error('仍写入失败，可继续重试');
}

async function discardJob(job: LacquerJob) {
  const confirmed = await ElMessageBox.confirm('放弃该待处理核销任务？尚未落库的改动将不生效。', '放弃任务', { type: 'warning' })
    .then(() => true)
    .catch(() => false);
  if (!confirmed) return;
  await lacquerStore.discardJob(job.id);
  ElMessage.success('已移除该待处理任务');
}

// ---------- 旧值留档 ----------
const historyVisible = ref(false);
const historySeq = ref(0);
const history = ref<LayerValueSnapshot[]>([]);
const currentValues = ref<{ mixRatio: string; layerThickness: number; appliedAt: string } | null>(null);

function openHistory(row: LacquerRow) {
  if (!row.layer) return;
  historySeq.value = row.seq;
  history.value = row.layer.valueHistory ?? [];
  currentValues.value = {
    mixRatio: row.layer.mixRatio,
    layerThickness: row.layer.layerThickness,
    appliedAt: row.layer.appliedAt,
  };
  historyVisible.value = true;
}

function diffClass(row: LacquerRow, field: 'thickness' | 'mixRatio' | 'appliedAt'): string {
  return row.diff?.[field] ? 'cell-diff' : '';
}

function rowClassName({ row }: { row: LacquerRow }): string {
  return rowIncluded(row) ? '' : 'row-pending';
}
</script>

<template>
  <div>
    <h2 class="page-title">灰胎髹漆遍次台账</h2>
    <p class="page-desc">
      本坊髹漆遍次与外协漆坊回执分两套来源登记，按琴号 + 遍次对账；厚度 / 配比 / 施工日期不一致时保留双方并标记待复核，未决遍次不计入累计，灰胎未核销达标前上弦环节不予放行。
    </p>

    <el-alert
      v-for="job in lacquerStore.failedJobs"
      :key="job.id"
      class="job-alert"
      type="error"
      :closable="false"
      show-icon
    >
      <template #title>
        <div class="job-line">
          <span>
            核销写入失败（{{ JOB_KIND_TEXT[job.kind] }}
            <template v-if="job.guqinNo">· {{ job.guqinNo }} 第 {{ job.seq }} 遍</template>）：{{ job.lastError || '未知错误' }}，已保留核销位置
          </span>
          <span class="job-actions">
            <el-button size="small" type="primary" @click="retryJob(job)">重试</el-button>
            <el-button size="small" @click="discardJob(job)">放弃</el-button>
          </span>
        </div>
      </template>
    </el-alert>

    <div class="toolbar">
      <el-button type="primary" @click="openAppend">追加本坊遍次</el-button>
      <el-button type="warning" plain @click="openReceipt()">登记外协回执</el-button>
      <el-select v-model="selectedGuqin" placeholder="选择琴号" style="width: 180px">
        <el-option v-for="no in guqinOptions" :key="no" :label="no" :value="no" />
      </el-select>
      <el-tag type="warning" effect="plain">髹漆目标累计 {{ TARGET_TOTAL_MM }}mm</el-tag>
      <el-tag v-if="pending" type="danger" effect="dark">{{ pending }} 遍待复核，未计入累计</el-tag>
    </div>

    <el-row :gutter="12" class="stat-row">
      <el-col :xs="12" :md="6">
        <StatBadge label="已核销遍次" :value="settledLayers.length" :unit="`/ ${rows.length} 遍`" />
      </el-col>
      <el-col :xs="12" :md="6">
        <StatBadge label="有效累计厚度" :value="total.toFixed(2)" unit="mm" :status="total >= TARGET_TOTAL_MM ? 'success' : 'warning'" />
      </el-col>
      <el-col :xs="12" :md="6">
        <StatBadge label="每遍平均厚度" :value="averageThickness(settledLayers)" unit="mm" />
      </el-col>
      <el-col :xs="12" :md="6">
        <StatBadge label="待复核 / 超窗口" :value="pending" :unit="`/ ${abnormal} 遍`" :status="pending ? 'danger' : abnormal ? 'warning' : 'success'" />
      </el-col>
    </el-row>

    <EmptyPanel v-if="rows.length === 0" description="该琴暂无本坊遍次或外协回执" action-text="追加本坊遍次" @action="openAppend" />

    <template v-else>
      <el-card shadow="never" class="block">
        <template #header>
          <div class="card-head">
            <span>层积与有效累计厚度（仅已核销遍次）</span>
            <span class="card-note">按当前每遍厚度，距目标还需约 {{ layersToTarget(settledLayers, TARGET_TOTAL_MM) }} 遍</span>
          </div>
        </template>
        <LayerStack :layers="settledLayers" />
      </el-card>

      <el-card shadow="never" class="block">
        <template #header>
          <div class="card-head">
            <span>对账核销明细（本坊遍次 × 外协回执）</span>
            <el-button size="small" type="warning" plain @click="openReceipt()">补登记回执</el-button>
          </div>
        </template>
        <el-table :data="rows" size="small" border :row-class-name="rowClassName">
          <el-table-column prop="seq" label="遍次" width="64" />
          <el-table-column label="状态" width="118">
            <template #default="scope">
              <el-tag :type="STATE_TAG[scope.row.state as RowState].type" size="small">
                {{ STATE_TAG[scope.row.state as RowState].text }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="本坊厚度/配比/日期" min-width="210">
            <template #default="scope">
              <template v-if="scope.row.layer">
                <div :class="diffClass(scope.row, 'thickness')">{{ scope.row.layer.layerThickness }}mm · {{ scope.row.layer.mixRatio }}</div>
                <div class="sub" :class="diffClass(scope.row, 'appliedAt')">{{ formatDate(scope.row.layer.appliedAt) }} · {{ scope.row.layer.operator }}</div>
              </template>
              <el-tag v-else type="warning" size="small">本坊无此遍记录</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="外协回执厚度/配比/日期" min-width="230">
            <template #default="scope">
              <template v-if="scope.row.receipt">
                <div :class="diffClass(scope.row, 'thickness')">{{ scope.row.receipt.layerThickness }}mm · <span :class="diffClass(scope.row, 'mixRatio')">{{ scope.row.receipt.mixRatio }}</span></div>
                <div class="sub">
                  {{ formatDate(scope.row.receipt.appliedAt) }} · {{ scope.row.receipt.workshop }}
                </div>
                <div class="sub muted">
                  回执 {{ scope.row.receipt.receiptNo || '无单号' }} / 批号 {{ scope.row.receipt.localBatchNo }}
                  <template v-if="scope.row.receipt.mergedCount"> · 重复送达 {{ scope.row.receipt.mergedCount }} 次（已合并）</template>
                </div>
              </template>
              <span v-else class="muted">无回执</span>
            </template>
          </el-table-column>
          <el-table-column label="差异" width="150">
            <template #default="scope">
              <template v-if="scope.row.diff && (scope.row.diff.thickness || scope.row.diff.mixRatio || scope.row.diff.appliedAt)">
                <el-tag v-if="scope.row.diff.thickness" size="small" type="danger" class="diff-tag">厚度</el-tag>
                <el-tag v-if="scope.row.diff.mixRatio" size="small" type="danger" class="diff-tag">配比</el-tag>
                <el-tag v-if="scope.row.diff.appliedAt" size="small" type="danger" class="diff-tag">日期</el-tag>
              </template>
              <el-tag v-else-if="scope.row.state === 'receipt-only'" size="small" type="warning">待入册</el-tag>
              <el-tag v-else-if="scope.row.state === 'local-only' || scope.row.state === 'matched'" size="small" type="success">一致</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="累计(mm)" width="96">
            <template #default="scope">
              <template v-if="scope.row.layer">
                {{ scope.row.layer.totalThickness.toFixed(2) }}
                <div v-if="!rowIncluded(scope.row)" class="sub danger">未决不计</div>
              </template>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="238" fixed="right">
            <template #default="scope">
              <template v-if="scope.row.state === 'disputed'">
                <el-button link type="primary" @click="confirmResolve(scope.row, 'outsource')">采用外协值</el-button>
                <el-button link type="success" @click="confirmResolve(scope.row, 'local')">维持本坊值</el-button>
              </template>
              <template v-else-if="scope.row.state === 'receipt-only'">
                <el-button link type="primary" @click="confirmResolve(scope.row, 'outsource')">回执入账</el-button>
                <el-button v-if="scope.row.receipt" link type="danger" @click="removeReceipt(scope.row.receipt)">删回执</el-button>
              </template>
              <template v-else>
                <el-button v-if="scope.row.layer" link type="primary" @click="openEdit(scope.row)">编辑</el-button>
                <el-button
                  v-if="scope.row.state === 'resolved-local' || scope.row.state === 'resolved-outsource'"
                  link
                  type="warning"
                  @click="confirmReopen(scope.row)"
                >
                  重新对账
                </el-button>
                <el-button v-if="scope.row.layer?.valueHistory?.length" link type="info" @click="openHistory(scope.row)">旧值({{ scope.row.layer.valueHistory.length }})</el-button>
                <el-button v-if="scope.row.layer" link type="danger" @click="removeLayer(scope.row)">删本坊</el-button>
                <el-button v-if="scope.row.receipt && scope.row.state === 'matched'" link type="danger" @click="removeReceipt(scope.row.receipt)">删回执</el-button>
              </template>
            </template>
          </el-table-column>
        </el-table>
      </el-card>
    </template>

    <!-- 本坊遍次对话框 -->
    <el-dialog v-model="layerDialogVisible" :title="editingId ? '编辑本坊髹漆遍次' : '追加本坊髹漆遍次'" width="640px">
      <el-form ref="layerFormRef" :model="layerForm" :rules="layerRules" label-width="130px">
        <el-form-item label="琴号" prop="guqinNo">
          <el-input v-model="layerForm.guqinNo" placeholder="如：Q-2501" maxlength="20" style="width: 200px" />
        </el-form-item>
        <el-form-item label="来源">
          <el-tag type="info" size="small">本坊自做（外协回执请走「登记外协回执」）</el-tag>
        </el-form-item>
        <el-form-item label="灰胎配比">
          <el-select v-model="layerForm.mixRatio" style="width: 200px">
            <el-option v-for="ratio in MIX_RATIOS" :key="ratio" :label="ratio" :value="ratio" />
          </el-select>
        </el-form-item>
        <el-form-item label="荫房温度(℃)">
          <el-input-number v-model="layerForm.curingTemp" :min="5" :max="45" placeholder="荫房温度" />
        </el-form-item>
        <el-form-item label="荫房湿度(%)">
          <el-input-number v-model="layerForm.curingHumidity" :min="30" :max="100" placeholder="湿度" />
        </el-form-item>
        <el-form-item label="打磨目数">
          <el-input-number v-model="layerForm.polishGrit" :min="80" :max="2000" :step="20" placeholder="打磨目数" />
        </el-form-item>
        <el-form-item label="本遍厚度(mm)">
          <el-input-number v-model="layerForm.layerThickness" :min="0.01" :max="1" :step="0.01" :precision="2" placeholder="本遍厚度" />
        </el-form-item>
        <el-form-item label="施工日期">
          <el-date-picker v-model="layerForm.appliedAt" type="date" value-format="YYYY-MM-DD" placeholder="选择日期" />
        </el-form-item>
        <el-form-item label="髹漆人" prop="operator">
          <el-input v-model="layerForm.operator" placeholder="如：林听雪" maxlength="16" style="width: 200px" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="layerForm.remark" type="textarea" :rows="2" maxlength="60" placeholder="干燥情况等" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="layerDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitLayer">保存</el-button>
      </template>
    </el-dialog>

    <!-- 外协回执对话框 -->
    <el-dialog v-model="receiptDialogVisible" title="登记外协漆坊施工回执" width="680px">
      <el-alert type="info" :closable="false" show-icon class="block">
        回执按琴号 + 遍次与本坊记录对账；同一回执重复送达只合并次数、不新增遍次。地方批号与本坊遍次对不上时可先登记，随后核销入账。
      </el-alert>
      <el-form ref="receiptFormRef" :model="receiptForm" :rules="receiptRules" label-width="130px">
        <el-form-item label="外协漆坊" prop="workshop">
          <el-input v-model="receiptForm.workshop" placeholder="如：徽城漆坊" maxlength="30" style="width: 240px" />
        </el-form-item>
        <el-form-item label="回执单号">
          <el-input v-model="receiptForm.receiptNo" placeholder="外协回执单号（可空，空时按琴号遍次批号去重）" maxlength="40" style="width: 320px" />
        </el-form-item>
        <el-form-item label="地方批号" prop="localBatchNo">
          <el-input v-model="receiptForm.localBatchNo" placeholder="外协坊自己的批号" maxlength="40" style="width: 240px" />
        </el-form-item>
        <el-form-item label="琴号" prop="guqinNo">
          <el-input v-model="receiptForm.guqinNo" placeholder="如：Q-2504" maxlength="20" style="width: 200px" />
        </el-form-item>
        <el-form-item label="遍次" prop="seq">
          <el-input-number v-model="receiptForm.seq" :min="1" :max="99" placeholder="回执填报遍次" />
        </el-form-item>
        <el-form-item label="回执厚度(mm)">
          <el-input-number v-model="receiptForm.layerThickness" :min="0.01" :max="1" :step="0.01" :precision="2" />
        </el-form-item>
        <el-form-item label="灰胎配比">
          <el-select v-model="receiptForm.mixRatio" style="width: 200px">
            <el-option v-for="ratio in MIX_RATIOS" :key="ratio" :label="ratio" :value="ratio" />
          </el-select>
        </el-form-item>
        <el-form-item label="施工日期">
          <el-date-picker v-model="receiptForm.appliedAt" type="date" value-format="YYYY-MM-DD" placeholder="选择日期" />
        </el-form-item>
        <el-form-item label="温湿度/目数">
          <el-input-number v-model="receiptForm.curingTemp" :min="5" :max="45" placeholder="温度(可空)" :value-on-clear="null" />
          <el-input-number v-model="receiptForm.curingHumidity" :min="30" :max="100" placeholder="湿度(可空)" :value-on-clear="null" class="receipt-field" />
          <el-input-number v-model="receiptForm.polishGrit" :min="80" :max="2000" :step="20" placeholder="目数(可空)" :value-on-clear="null" class="receipt-field" />
        </el-form-item>
        <el-form-item label="外协经手人">
          <el-input v-model="receiptForm.operator" placeholder="可空" maxlength="16" style="width: 200px" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="receiptForm.remark" type="textarea" :rows="2" maxlength="60" placeholder="中途退出 / 复测说明等" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="receiptDialogVisible = false">取消</el-button>
        <el-button type="warning" @click="submitReceipt">登记回执</el-button>
      </template>
    </el-dialog>

    <!-- 旧值留档对话框 -->
    <el-dialog v-model="historyVisible" :title="`第 ${historySeq} 遍核销旧值留档`" width="560px">
      <el-alert v-if="currentValues" type="success" :closable="false" class="block" title="当前采用值">
        <div>{{ currentValues.layerThickness }}mm · {{ currentValues.mixRatio }} · {{ formatDate(currentValues.appliedAt) }}</div>
      </el-alert>
      <el-table :data="history" size="small" border>
        <el-table-column label="留档方" width="90">
          <template #default="scope">{{ scope.row.basis === 'local' ? '本坊旧值' : '外协值' }}</template>
        </el-table-column>
        <el-table-column label="厚度(mm)" prop="layerThickness" width="90" />
        <el-table-column label="配比" prop="mixRatio" width="100" />
        <el-table-column label="施工日期" width="120">
          <template #default="scope">{{ formatDate(scope.row.appliedAt) }}</template>
        </el-table-column>
        <el-table-column label="核销时间" min-width="140">
          <template #default="scope">{{ formatDate(scope.row.savedAt) }}</template>
        </el-table-column>
      </el-table>
    </el-dialog>
  </div>
</template>

<style scoped>
.page-title {
  margin: 0 0 4px;
  font-size: 20px;
  color: #4a3728;
}
.page-desc {
  margin: 0 0 12px;
  color: #8a7a68;
  font-size: 13px;
}
.toolbar {
  display: flex;
  gap: 10px;
  align-items: center;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.stat-row {
  margin-bottom: 12px;
}
.stat-row .el-col {
  margin-bottom: 12px;
}
.block {
  margin-bottom: 16px;
  border-radius: 8px;
}
.card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.card-note {
  font-size: 12px;
  color: #8a7a68;
}
.sub {
  font-size: 12px;
  color: #6b5a48;
}
.muted {
  color: #a3968a;
}
.danger {
  color: #c62828;
}
.cell-diff {
  color: #c62828;
  font-weight: 600;
}
.diff-tag {
  margin: 2px 4px 2px 0;
}
.receipt-field {
  margin-left: 8px;
}
.job-alert {
  margin-bottom: 12px;
}
.job-line {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.job-actions {
  white-space: nowrap;
}
:deep(.row-pending) {
  background-color: #fdf3ec;
}
</style>
