<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import { RefreshRight, Delete } from '@element-plus/icons-vue';
import StatBadge from '../components/common/StatBadge.vue';
import EmptyPanel from '../components/common/EmptyPanel.vue';
import { useReceiptStore, type ReceiptInput } from '../stores/receiptStore';
import { useLacquerStore } from '../stores/lacquerStore';
import { useBoardStore } from '../stores/boardStore';
import { formatDate } from '../utils/layer';
import { DIFF_LABELS, RECON_STATUS_LABELS, RECEIPT_STATUS_LABELS } from '../types/outsourced';
import { MIX_RATIOS } from '../types/lacquer-layer';
import type { OutsourcedReceipt } from '../types/outsourced';
import type { ReconRow } from '../utils/reconcile';

const receiptStore = useReceiptStore();
const lacquerStore = useLacquerStore();
const boardStore = useBoardStore();

// —— 顶部统计 ——
const totalReceipts = computed(() => receiptStore.receipts.length);
const withdrawnCount = computed(() => receiptStore.withdrawnCount);
const openCount = computed(() => lacquerStore.openCount);
const cursor = computed(() => receiptStore.cursor);
const queueProgress = computed(() => {
  if (!cursor.value || cursor.value.total === 0) return 0;
  return Math.round((cursor.value.position / cursor.value.total) * 100);
});

// —— 批量回传（文本框，一行一张回执）——
const batchVisible = ref(false);
const batchText = ref('');
const batchNote = ref('每行一张：回执单号,地方批号,琴号,遍次,厚度,配比,施工日期(YYYY-MM-DD),漆坊/施工人');

const PLACEHOLDER = `WX-2511-01,DF-1201,Q-2504,3,0.08,1:1.5,2026-09-20,永嘉外协漆坊·阿福
WX-2511-02,DF-1201,Q-2504,4,0.06,纯生漆,2026-09-27,永嘉外协漆坊·阿福`;

function parseBatch(text: string): ReceiptInput[] {
  const result: ReceiptInput[] = [];
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const parts = line.split(',').map((p) => p.trim());
    if (parts.length < 8) {
      throw new Error(`行格式不足 8 列：「${line}」`);
    }
    const [receiptNo, batchNo, guqinNo, seqStr, thickStr, mixRatio, dateStr, workshop] = parts;
    const seq = Number(seqStr);
    const thickness = Number(thickStr);
    if (!Number.isFinite(seq) || seq <= 0) throw new Error(`遍次非法：「${line}」`);
    if (!Number.isFinite(thickness) || thickness <= 0) throw new Error(`厚度非法：「${line}」`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) throw new Error(`施工日期需为 YYYY-MM-DD：「${line}」`);
    result.push({
      receiptNo,
      batchNo,
      guqinNo,
      seq,
      layerThickness: thickness,
      mixRatio,
      appliedAt: new Date(`${dateStr}T09:00:00`).toISOString(),
      workshop,
      status: 'active',
    });
  }
  return result;
}

async function submitBatch() {
  let inputs: ReceiptInput[];
  try {
    inputs = parseBatch(batchText.value);
  } catch (error) {
    ElMessage.error((error as Error).message);
    return;
  }
  if (!inputs.length) {
    ElMessage.warning('没有可核销的回执行');
    return;
  }
  const { queued, skipped } = await receiptStore.enqueue(inputs);
  ElMessage.success(`已入队 ${queued} 张${skipped.length ? `，重复回执跳过 ${skipped.length} 张（不新增遍次）` : ''}`);
  batchVisible.value = false;
  batchText.value = '';
  await runIngest();
}

async function runIngest() {
  try {
    const { ingested } = await receiptStore.processQueue();
    if (ingested > 0) ElMessage.success(`已核销 ${ingested} 张回执，累计厚度按可核销遍次重算`);
  } catch (error) {
    ElMessage.error(`核销中断：${(error as Error).message}；已核销位置已保留，可点重试继续。`);
  }
}

async function clearQueue() {
  const confirmed = await ElMessageBox.confirm('确认清空待核销队列？已入库回执不受影响。', '清空确认', { type: 'warning' })
    .then(() => true)
    .catch(() => false);
  if (!confirmed) return;
  await receiptStore.clearQueue();
  ElMessage.success('待核销队列已清空');
}

// —— 单张回执编辑 ——
const dialogVisible = ref(false);
const editingId = ref('');
const formRef = ref<FormInstance>();
const receiptForm = ref<ReceiptForm>(emptyReceiptForm());

interface ReceiptForm {
  receiptNo: string;
  batchNo: string;
  guqinNo: string;
  seq: number;
  layerThickness: number;
  mixRatio: string;
  appliedAt: string;
  workshop: string;
  status: 'active' | 'withdrawn';
  remark: string;
}

function emptyReceiptForm(guqinNo = ''): ReceiptForm {
  return {
    receiptNo: '',
    batchNo: '',
    guqinNo,
    seq: 1,
    layerThickness: 0.1,
    mixRatio: '1:1',
    appliedAt: new Date().toISOString().slice(0, 10),
    workshop: '永嘉外协漆坊·阿福',
    status: 'active',
    remark: '',
  };
}

const receiptRules: FormRules = {
  receiptNo: [{ required: true, message: '请输入回执单号', trigger: 'blur' }],
  batchNo: [{ required: true, message: '请输入地方批号', trigger: 'blur' }],
  guqinNo: [{ required: true, message: '请输入琴号', trigger: 'blur' }],
  workshop: [{ required: true, message: '请输入漆坊/施工人', trigger: 'blur' }],
};

function openCreate() {
  editingId.value = '';
  receiptForm.value = emptyReceiptForm(boardStore.guqinNos[0] ?? lacquerStore.guqinNos[0] ?? 'Q-2501');
  dialogVisible.value = true;
}

function openEdit(receipt: OutsourcedReceipt) {
  editingId.value = receipt.id;
  receiptForm.value = {
    receiptNo: receipt.receiptNo,
    batchNo: receipt.batchNo,
    guqinNo: receipt.guqinNo,
    seq: receipt.seq,
    layerThickness: receipt.layerThickness,
    mixRatio: receipt.mixRatio,
    appliedAt: receipt.appliedAt.slice(0, 10),
    workshop: receipt.workshop,
    status: receipt.status,
    remark: receipt.remark ?? '',
  };
  dialogVisible.value = true;
}

async function submitReceipt() {
  const ok = await formRef.value?.validate().catch(() => false);
  if (!ok) return;
  const payload: ReceiptInput = {
    receiptNo: receiptForm.value.receiptNo,
    batchNo: receiptForm.value.batchNo,
    guqinNo: receiptForm.value.guqinNo,
    seq: Number(receiptForm.value.seq) || 0,
    layerThickness: Number(receiptForm.value.layerThickness) || 0,
    mixRatio: receiptForm.value.mixRatio,
    appliedAt: new Date(`${receiptForm.value.appliedAt}T09:00:00`).toISOString(),
    workshop: receiptForm.value.workshop,
    status: receiptForm.value.status,
    remark: receiptForm.value.remark,
  };
  if (editingId.value) {
    await receiptStore.saveReceipt(payload, editingId.value);
    ElMessage.success('回执已更新，对账与累计厚度立即重算');
  } else {
    // 单张登记也走进队+核销，复用去重、游标与重试
    const { queued, skipped } = await receiptStore.enqueue([payload]);
    if (skipped.length) {
      ElMessage.warning('该回执单号已存在，重复回执不新增');
    } else {
      ElMessage.success(`回执 ${payload.receiptNo} 已入队（第 ${queued} 张）`);
    }
    await runIngest();
  }
  dialogVisible.value = false;
}

async function toggleWithdrawn(receipt: OutsourcedReceipt) {
  if (receipt.status === 'withdrawn') {
    await receiptStore.markActive(receipt.id);
    ElMessage.success('已撤销退出标记，回执重新参与对账');
  } else {
    const confirmed = await ElMessageBox.confirm(
      `确认回执 ${receipt.receiptNo}（${receipt.guqinNo} 第 ${receipt.seq} 遍）中途退出？退出后以本坊记录为准。`,
      '中途退出确认',
      { type: 'warning' },
    ).then(() => true).catch(() => false);
    if (!confirmed) return;
    await receiptStore.markWithdrawn(receipt.id);
    ElMessage.success('已标记中途退出，该遍及后续累计厚度重算');
  }
}

async function removeReceipt(receipt: OutsourcedReceipt) {
  const confirmed = await ElMessageBox.confirm(`确认删除回执 ${receipt.receiptNo}？删除后该琴累计厚度立即重算。`, '删除确认', { type: 'warning' })
    .then(() => true)
    .catch(() => false);
  if (!confirmed) return;
  await receiptStore.removeReceipt(receipt.id);
  ElMessage.success('回执已删除并重算');
}

// —— 对账表 ——
const reconRows = computed<ReconRow[]>(() => lacquerStore.reconRows);
const statusFilter = ref('');
const filteredRows = computed(() => (statusFilter.value ? reconRows.value.filter((r) => r.status === statusFilter.value) : reconRows.value));

const STATUS_TAG: Record<string, 'success' | 'warning' | 'info' | 'danger'> = {
  reconciled: 'success',
  disputed: 'danger',
  'pending-local': 'info',
  'pending-receipt': 'warning',
  withdrawn: 'info',
};

async function adoptReceipt(row: ReconRow) {
  const confirmed = await ElMessageBox.confirm(
    `确认 ${row.guqinNo} 第 ${row.seq} 遍采用外协回执值？该遍及后续累计厚度、琴坯进度立即失效重算，本坊旧值留存可查阅。`,
    '采用外协值',
    { type: 'warning', confirmButtonText: '采用外协值' },
  ).then(() => true).catch(() => false);
  if (!confirmed) return;
  await lacquerStore.resolveWithReceipt({ guqinNo: row.guqinNo, seq: row.seq });
  ElMessage.success('已采用外协值，累计厚度与琴坯进度已重算');
}

async function keepLocal(row: ReconRow) {
  const confirmed = await ElMessageBox.confirm(`确认 ${row.guqinNo} 第 ${row.seq} 遍保留本坊记录值？回执日后再被改动会重新回到待复核。`, '保留本坊值', {
    type: 'info',
    confirmButtonText: '保留本坊值',
  }).then(() => true).catch(() => false);
  if (!confirmed) return;
  await lacquerStore.resolveWithLocal({ guqinNo: row.guqinNo, seq: row.seq });
  ElMessage.success('已按本坊值核销');
}
</script>

<template>
  <div>
    <h2 class="page-title">外协漆坊回执核销</h2>
    <p class="page-desc">
      外协回执与本坊髹漆遍次分两套来源，按琴号+遍次对账；地方批号/遍次对不上、厚度配比施工日期不一致时保留双方并待复核。
      未决遍次不参与累计厚度，也不能当作灰胎完工进入上弦。
    </p>

    <div class="toolbar">
      <el-button type="primary" @click="openCreate">登记单张回执</el-button>
      <el-button @click="batchVisible = true">批量回传回执</el-button>
      <el-tag type="danger" v-if="openCount" effect="dark">未决 {{ openCount }} 遍</el-tag>
      <el-tag type="info" effect="plain">中途退出 {{ withdrawnCount }} 张</el-tag>
    </div>

    <!-- 核销队列：失败后保留已核销位置，可重试 -->
    <el-card v-if="cursor" shadow="never" class="block queue-card">
      <template #header>
        <div class="card-head">
          <span>回执核销队列（重复回执不新增遍次）</span>
          <el-button link type="danger" :icon="Delete" @click="clearQueue">清空队列</el-button>
        </div>
      </template>
      <el-progress :percentage="queueProgress" :status="cursor.error ? 'exception' : 'success'" />
      <div class="queue-meta">
        已核销 {{ cursor.position }} / {{ cursor.total }} 张
        <span v-if="cursor.skipped.length" class="queue-skip">；重复跳过 {{ cursor.skipped.length }} 张</span>
      </div>
      <el-alert v-if="cursor.error" type="error" :closable="false" show-icon class="block">
        <template #title>
          <span>{{ cursor.error }}</span>
        </template>
      </el-alert>
      <div class="queue-actions">
        <el-button v-if="cursor.position < cursor.total" type="primary" :icon="RefreshRight" @click="runIngest">
          从第 {{ cursor.position + 1 }} 张重试核销
        </el-button>
        <el-tag v-else type="success" effect="plain">队列已全部核销</el-tag>
      </div>
    </el-card>

    <el-row :gutter="12" class="stat-row">
      <el-col :xs="12" :md="6">
        <StatBadge label="在册外协回执" :value="totalReceipts" unit="张" />
      </el-col>
      <el-col :xs="12" :md="6">
        <StatBadge label="未决待复核" :value="openCount" unit="遍" :status="openCount ? 'danger' : 'success'" />
      </el-col>
      <el-col :xs="12" :md="6">
        <StatBadge label="中途退出" :value="withdrawnCount" unit="张" />
      </el-col>
      <el-col :xs="12" :md="6">
        <StatBadge label="待核销队列" :value="receiptStore.pendingCount" unit="张" :status="receiptStore.pendingCount ? 'warning' : 'success'" />
      </el-col>
    </el-row>

    <el-card shadow="never" class="block">
      <template #header>
        <div class="card-head">
          <span>对账结果（琴号 + 遍次）</span>
          <el-radio-group v-model="statusFilter" size="small">
            <el-radio-button value="">全部</el-radio-button>
            <el-radio-button value="disputed">待复核</el-radio-button>
            <el-radio-button value="pending-receipt">遍次对不上</el-radio-button>
            <el-radio-button value="pending-local">回执未到</el-radio-button>
            <el-radio-button value="reconciled">已核销</el-radio-button>
            <el-radio-button value="withdrawn">中途退出</el-radio-button>
          </el-radio-group>
        </div>
      </template>
      <el-table :data="filteredRows" size="small" border>
        <el-table-column prop="guqinNo" label="琴号" width="95" />
        <el-table-column prop="seq" label="遍次" width="60" />
        <el-table-column label="状态" width="105">
          <template #default="scope">
            <el-tag :type="STATUS_TAG[scope.row.status]" size="small">{{ RECON_STATUS_LABELS[scope.row.status as keyof typeof RECON_STATUS_LABELS] }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="本坊记录" min-width="190">
          <template #default="scope">
            <template v-if="scope.row.local">
              {{ scope.row.local.layerThickness }}mm · {{ scope.row.local.mixRatio }} · {{ formatDate(scope.row.local.appliedAt) }}
              <span class="val-soft">（{{ scope.row.local.operator }}）</span>
            </template>
            <span v-else class="missing">本坊无此遍</span>
          </template>
        </el-table-column>
        <el-table-column label="外协回执" min-width="230">
          <template #default="scope">
            <template v-if="scope.row.receipt">
              <div class="receipt-cell">
                <span>{{ scope.row.receipt.receiptNo }} · 批号 {{ scope.row.receipt.batchNo }} · {{ scope.row.receipt.workshop }}</span>
                <span :class="scope.row.status === 'disputed' ? 'val-diff' : 'val-soft'">
                  {{ scope.row.receipt.layerThickness }}mm · {{ scope.row.receipt.mixRatio }} · {{ formatDate(scope.row.receipt.appliedAt) }}
                </span>
              </div>
            </template>
            <span v-else class="val-soft">回执未到</span>
          </template>
        </el-table-column>
        <el-table-column label="差异字段" width="160">
          <template #default="scope">
            <el-tag v-for="d in scope.row.diffs" :key="d" type="danger" size="small" class="diff-tag">
              {{ DIFF_LABELS[d as keyof typeof DIFF_LABELS] }}
            </el-tag>
            <span v-if="scope.row.status === 'pending-receipt'" class="missing">需补本坊遍次或核批号</span>
          </template>
        </el-table-column>
        <el-table-column label="核销操作" width="250" fixed="right">
          <template #default="scope">
            <template v-if="scope.row.status === 'disputed'">
              <el-button link type="warning" @click="adoptReceipt(scope.row)">采用外协值</el-button>
              <el-button link type="primary" @click="keepLocal(scope.row)">保留本坊值</el-button>
            </template>
            <template v-else-if="scope.row.status === 'pending-receipt'">
              <el-button link type="primary" @click="scope.row.receipt && openEdit(scope.row.receipt)">核对/改回执</el-button>
            </template>
            <el-tag v-else-if="scope.row.status === 'reconciled'" type="success" size="small" effect="plain">
              已核销{{ scope.row.local?.resolution === 'receipt' ? '·取外协' : scope.row.local?.resolution === 'local' ? '·取本坊' : '·一致' }}
            </el-tag>
            <el-tag v-else-if="scope.row.status === 'withdrawn'" type="info" size="small" effect="plain">以本坊为准</el-tag>
            <span v-else class="val-soft">等候回执</span>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never" class="block">
      <template #header>外协回执台账</template>
      <EmptyPanel v-if="receiptStore.receipts.length === 0" description="暂无外协回执，可单张登记或批量回传" />
      <el-table v-else :data="[...receiptStore.receipts].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))" size="small" border>
        <el-table-column prop="receiptNo" label="回执单号" width="130" />
        <el-table-column prop="batchNo" label="地方批号" width="100" />
        <el-table-column prop="guqinNo" label="琴号" width="90" />
        <el-table-column prop="seq" label="遍次" width="55" />
        <el-table-column prop="layerThickness" label="厚度(mm)" width="85" />
        <el-table-column prop="mixRatio" label="配比" width="90" />
        <el-table-column label="施工日期" width="105">
          <template #default="scope">{{ formatDate(scope.row.appliedAt) }}</template>
        </el-table-column>
        <el-table-column label="送达日期" width="105">
          <template #default="scope">{{ formatDate(scope.row.receivedAt) }}</template>
        </el-table-column>
        <el-table-column prop="workshop" label="漆坊/施工人" min-width="150" show-overflow-tooltip />
        <el-table-column label="状态" width="95">
          <template #default="scope">
            <el-tag :type="scope.row.status === 'withdrawn' ? 'info' : 'success'" size="small">
              {{ RECEIPT_STATUS_LABELS[scope.row.status as keyof typeof RECEIPT_STATUS_LABELS] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="230" fixed="right">
          <template #default="scope">
            <el-button link type="primary" @click="openEdit(scope.row)">编辑</el-button>
            <el-button link :type="scope.row.status === 'withdrawn' ? 'success' : 'warning'" @click="toggleWithdrawn(scope.row)">
              {{ scope.row.status === 'withdrawn' ? '撤销退出' : '中途退出' }}
            </el-button>
            <el-button link type="danger" @click="removeReceipt(scope.row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 批量回传对话框 -->
    <el-dialog v-model="batchVisible" title="批量回传外协回执" width="720px">
      <el-alert type="info" :closable="false" :title="batchNote" class="block" />
      <el-input v-model="batchText" type="textarea" :rows="8" :placeholder="PLACEHOLDER" />
      <template #footer>
        <el-button @click="batchVisible = false">取消</el-button>
        <el-button type="primary" @click="submitBatch">入队并核销</el-button>
      </template>
    </el-dialog>

    <!-- 单张回执对话框 -->
    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑外协回执' : '登记外协回执'" width="600px">
      <el-form ref="formRef" :model="receiptForm" :rules="receiptRules" label-width="120px">
        <el-form-item label="回执单号" prop="receiptNo">
          <el-input v-model="receiptForm.receiptNo" placeholder="如：WX-2511-01" maxlength="30" style="width: 240px" />
        </el-form-item>
        <el-form-item label="地方批号" prop="batchNo">
          <el-input v-model="receiptForm.batchNo" placeholder="外协地方批号，如：DF-1201" maxlength="30" style="width: 240px" />
        </el-form-item>
        <el-form-item label="琴号" prop="guqinNo">
          <el-input v-model="receiptForm.guqinNo" placeholder="本坊琴号，如：Q-2501" maxlength="20" style="width: 200px" />
        </el-form-item>
        <el-form-item label="遍次">
          <el-input-number v-model="receiptForm.seq" :min="1" :max="60" />
        </el-form-item>
        <el-form-item label="本遍厚度(mm)">
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
        <el-form-item label="漆坊/施工人" prop="workshop">
          <el-input v-model="receiptForm.workshop" placeholder="如：永嘉外协漆坊·阿福" maxlength="30" style="width: 260px" />
        </el-form-item>
        <el-form-item label="回执状态">
          <el-radio-group v-model="receiptForm.status">
            <el-radio value="active">在途</el-radio>
            <el-radio value="withdrawn">中途退出</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="receiptForm.remark" type="textarea" :rows="2" maxlength="80" placeholder="批号对不上、撤单原因等" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitReceipt">保存</el-button>
      </template>
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
.queue-card {
  border-left: 3px solid #c77700;
}
.card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.queue-meta {
  margin: 8px 0;
  font-size: 13px;
  color: #4a3728;
}
.queue-skip {
  color: #8a7a68;
}
.queue-actions {
  margin-top: 8px;
}
.receipt-cell {
  display: flex;
  flex-direction: column;
  font-size: 12px;
}
.val-soft {
  color: #b6a997;
  font-size: 12px;
}
.val-diff {
  color: #c62828;
  font-weight: 600;
}
.missing {
  color: #c62828;
  font-size: 12px;
}
.diff-tag {
  margin-right: 4px;
}
</style>
