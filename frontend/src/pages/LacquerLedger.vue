<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import StatBadge from '../components/common/StatBadge.vue';
import LayerStack from '../components/common/LayerStack.vue';
import EmptyPanel from '../components/common/EmptyPanel.vue';
import { useLacquerStore } from '../stores/lacquerStore';
import { useReceiptStore } from '../stores/receiptStore';
import { useBoardStore } from '../stores/boardStore';
import { averageThickness, curingInRange, formatDate } from '../utils/layer';
import { isEffectiveRow, layerSource } from '../utils/reconcile';
import { GRAY_BODY_TARGET_MM } from '../utils/reconcile';
import { MIX_RATIOS, type LacquerLayer, type LayerSnapshot } from '../types/lacquer-layer';
import { RECON_STATUS_LABELS, type LayerSource as Source, type ReconStatus } from '../types/outsourced';

const lacquerStore = useLacquerStore();
const receiptStore = useReceiptStore();
const boardStore = useBoardStore();

const guqinOptions = computed(() =>
  Array.from(new Set([...boardStore.guqinNos, ...lacquerStore.guqinNos, ...receiptStore.guqinNos])).sort(),
);
const selectedGuqin = ref(guqinOptions.value[0] ?? '');
watch(guqinOptions, (list) => {
  if (!selectedGuqin.value && list.length) {
    selectedGuqin.value = list[0];
  }
});

const layers = computed(() => (selectedGuqin.value ? lacquerStore.layersOf(selectedGuqin.value) : []));
const total = computed(() => (selectedGuqin.value ? lacquerStore.totalOf(selectedGuqin.value) : 0));
const abnormal = computed(() => layers.value.filter((layer) => !curingInRange(layer.curingTemp, layer.curingHumidity)).length);

/** 该琴的对账行，按遍次映射 */
const rowBySeq = computed(() => {
  const map = new Map<number, (typeof lacquerStore.reconRows)[number]>();
  lacquerStore.reconRows
    .filter((r) => r.guqinNo === selectedGuqin.value)
    .forEach((r) => map.set(r.seq, r));
  return map;
});

const effectiveLayers = computed(() =>
  layers.value.filter((l) => {
    const row = rowBySeq.value.get(l.seq);
    return row ? isEffectiveRow(row) : true;
  }),
);
const effectiveIds = computed(() => new Set(effectiveLayers.value.map((l) => l.id)));
const openRows = computed(() => lacquerStore.openRows(selectedGuqin.value));

const STATUS_TAG: Record<ReconStatus, 'success' | 'warning' | 'info' | 'danger'> = {
  reconciled: 'success',
  disputed: 'danger',
  'pending-local': 'info',
  'pending-receipt': 'warning',
  withdrawn: 'info',
};

function rowOf(layer: LacquerLayer) {
  return rowBySeq.value.get(layer.seq);
}

function isPending(layer: LacquerLayer): boolean {
  const row = rowOf(layer);
  return row ? !isEffectiveRow(row) : false;
}

function rowClass({ row }: { row: LacquerLayer }): string {
  return isPending(row) ? 'row-pending' : '';
}

function diffLabel(layer: LacquerLayer): string {
  const row = rowOf(layer);
  if (!row || row.status !== 'disputed') return '';
  const labels: Record<string, string> = { layerThickness: '厚度', mixRatio: '配比', appliedAt: '施工日期' };
  return row.diffs.map((d) => labels[d]).join('、');
}

const dialogVisible = ref(false);
const editingId = ref('');
const formRef = ref<FormInstance>();

interface LacquerForm {
  guqinNo: string;
  source: Source;
  mixRatio: string;
  curingTemp: number;
  curingHumidity: number;
  polishGrit: number;
  layerThickness: number;
  appliedAt: string;
  operator: string;
  remark: string;
}

const form = ref<LacquerForm>(emptyForm());

function emptyForm(guqinNo = ''): LacquerForm {
  return {
    guqinNo,
    source: 'local',
    mixRatio: '1:1',
    curingTemp: 25,
    curingHumidity: 78,
    polishGrit: 320,
    layerThickness: 0.1,
    appliedAt: new Date().toISOString().slice(0, 10),
    operator: '林听雪',
    remark: '',
  };
}

const rules: FormRules = {
  guqinNo: [{ required: true, message: '请输入琴号', trigger: 'blur' }],
  operator: [{ required: true, message: '请输入髹漆人', trigger: 'blur' }],
};

function openAppend() {
  editingId.value = '';
  form.value = emptyForm(selectedGuqin.value || guqinOptions.value[0] || 'Q-2501');
  dialogVisible.value = true;
}

function openEdit(layer: LacquerLayer) {
  editingId.value = layer.id;
  form.value = {
    guqinNo: layer.guqinNo,
    source: layerSource(layer),
    mixRatio: layer.mixRatio,
    curingTemp: layer.curingTemp,
    curingHumidity: layer.curingHumidity,
    polishGrit: layer.polishGrit,
    layerThickness: layer.layerThickness,
    appliedAt: layer.appliedAt.slice(0, 10),
    operator: layer.operator,
    remark: layer.remark ?? '',
  };
  dialogVisible.value = true;
}

async function submit() {
  const ok = await formRef.value?.validate().catch(() => false);
  if (!ok) return;
  const payload = {
    guqinNo: form.value.guqinNo,
    source: form.value.source,
    mixRatio: form.value.mixRatio,
    curingTemp: Number(form.value.curingTemp) || 0,
    curingHumidity: Number(form.value.curingHumidity) || 0,
    polishGrit: Number(form.value.polishGrit) || 0,
    layerThickness: Number(form.value.layerThickness) || 0,
    appliedAt: new Date(`${form.value.appliedAt}T09:00:00`).toISOString(),
    operator: form.value.operator,
    remark: form.value.remark,
  };
  if (editingId.value) {
    await lacquerStore.updateLayer(editingId.value, payload);
    ElMessage.success('已更新该遍记录并按对账结果重算累计厚度');
  } else {
    const created = await lacquerStore.appendLayer(payload);
    selectedGuqin.value = created.guqinNo;
    ElMessage.success(`已追加第 ${created.seq} 遍`);
  }
  dialogVisible.value = false;
}

async function remove(layer: LacquerLayer) {
  const confirmed = await ElMessageBox.confirm(`确认删除 ${layer.guqinNo} 第 ${layer.seq} 遍记录？`, '删除确认', { type: 'warning' })
    .then(() => true)
    .catch(() => false);
  if (!confirmed) return;
  await lacquerStore.removeLayer(layer.id);
  ElMessage.success('已删除并按对账结果重算累计厚度');
}

// 旧值快照查阅
const historyLayer = ref<LacquerLayer | null>(null);
const historyVisible = ref(false);
function openHistory(layer: LacquerLayer) {
  historyLayer.value = layer;
  historyVisible.value = true;
}
const snapshots = computed<LayerSnapshot[]>(() => historyLayer.value?.snapshots ?? []);
</script>

<template>
  <div>
    <h2 class="page-title">灰胎髹漆遍次台账</h2>
    <p class="page-desc">
      本坊遍次与外协回执分两套来源，按琴号+遍次核销；厚度 / 配比 / 施工日期不一致时保留双方并标记待复核，未决遍次不参与累计。
    </p>

    <div class="toolbar">
      <el-button type="primary" @click="openAppend">追加髹漆遍次</el-button>
      <el-select v-model="selectedGuqin" placeholder="选择琴号" style="width: 180px">
        <el-option v-for="no in guqinOptions" :key="no" :label="no" :value="no" />
      </el-select>
      <el-tag type="warning" effect="plain">灰胎完工累计 {{ GRAY_BODY_TARGET_MM }}mm</el-tag>
      <el-tag v-if="openRows.length" type="danger" effect="dark">{{ openRows.length }} 遍核销未决</el-tag>
    </div>

    <el-row :gutter="12" class="stat-row">
      <el-col :xs="12" :md="6">
        <StatBadge label="该琴髹漆遍次" :value="layers.length" unit="遍" />
      </el-col>
      <el-col :xs="12" :md="6">
        <StatBadge
          label="可核销累计厚度"
          :value="total.toFixed(2)"
          unit="mm"
          :status="total >= GRAY_BODY_TARGET_MM && openRows.length === 0 ? 'success' : 'warning'"
        />
      </el-col>
      <el-col :xs="12" :md="6">
        <StatBadge label="可核销每遍平均" :value="averageThickness(effectiveLayers)" unit="mm" />
      </el-col>
      <el-col :xs="12" :md="6">
        <StatBadge label="荫房超窗口遍次" :value="abnormal" unit="遍" :status="abnormal ? 'danger' : 'success'" />
      </el-col>
    </el-row>

    <EmptyPanel v-if="layers.length === 0 && openRows.length === 0" description="该琴暂无髹漆遍次记录" action-text="追加髹漆遍次" @action="openAppend" />

    <template v-else>
      <el-card shadow="never" class="block">
        <template #header>
          <div class="card-head">
            <span>层积与累计厚度</span>
            <span class="card-note">仅可核销遍次计入；待复核 / 遍次对不上的回执对应遍次以虚线标出</span>
          </div>
        </template>
        <LayerStack :layers="layers" :effective-ids="effectiveIds" :target-mm="GRAY_BODY_TARGET_MM" show-curing />
      </el-card>

      <el-alert
        v-for="row in openRows"
        :key="row.key"
        class="block"
        type="warning"
        :closable="false"
        show-icon
      >
        <template #title>
          <span v-if="row.status === 'disputed'">
            第 {{ row.seq }} 遍与外协回执 {{ row.receipt?.receiptNo }}（{{ row.receipt?.workshop }}）在「{{ diffLabel(row.local!) }}」上不一致，待复核；
            该遍暂不计入累计厚度。
          </span>
          <span v-else>
            外协回执 {{ row.receipt?.receiptNo }} 报第 {{ row.seq }} 遍（地方批号 {{ row.receipt?.batchNo }}），本坊台账无此遍，待复核；
            该回执暂不参与累计。
          </span>
        </template>
      </el-alert>

      <el-card shadow="never" class="block">
        <template #header>遍次明细（含双边核销状态）</template>
        <el-table :data="layers" size="small" border :row-class-name="rowClass">
          <el-table-column prop="seq" label="遍次" width="64" />
          <el-table-column label="来源" width="90">
            <template #default="scope">
              <el-tag :type="layerSource(scope.row) === 'local' ? '' : 'warning'" size="small">
                {{ layerSource(scope.row) === 'local' ? '本坊' : '外协' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="核销状态" width="110">
            <template #default="scope">
              <el-tag v-if="rowOf(scope.row)" :type="STATUS_TAG[rowOf(scope.row)!.status]" size="small">
                {{ RECON_STATUS_LABELS[rowOf(scope.row)!.status] }}
              </el-tag>
              <span v-else>—</span>
            </template>
          </el-table-column>
          <el-table-column prop="mixRatio" label="配比" width="90" />
          <el-table-column prop="curingTemp" label="荫房(℃)" width="90" />
          <el-table-column prop="curingHumidity" label="湿度(%)" width="80" />
          <el-table-column prop="polishGrit" label="目数" width="80" />
          <el-table-column label="本遍(mm)" width="90">
            <template #default="scope">
              <span :class="{ 'val-muted': isPending(scope.row) }">{{ scope.row.layerThickness }}</span>
            </template>
          </el-table-column>
          <el-table-column label="累计(mm)" width="90">
            <template #default="scope">
              <span v-if="!isPending(scope.row)">{{ scope.row.totalThickness?.toFixed?.(2) ?? '—' }}</span>
              <el-tag v-else type="warning" size="small">不计</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="施工日期" width="105">
            <template #default="scope">{{ formatDate(scope.row.appliedAt) }}</template>
          </el-table-column>
          <el-table-column label="回执侧" min-width="150">
            <template #default="scope">
              <template v-if="rowOf(scope.row)?.receipt">
                <div class="receipt-cell">
                  <span>{{ rowOf(scope.row)!.receipt!.receiptNo }} · {{ rowOf(scope.row)!.receipt!.workshop }}</span>
                  <span class="receipt-vals" :class="{ 'val-diff': isPending(scope.row) }">
                    {{ rowOf(scope.row)!.receipt!.layerThickness }}mm · {{ rowOf(scope.row)!.receipt!.mixRatio }} ·
                    {{ formatDate(rowOf(scope.row)!.receipt!.appliedAt) }}
                  </span>
                </div>
              </template>
              <span v-else class="val-soft">回执未到</span>
            </template>
          </el-table-column>
          <el-table-column prop="operator" label="髹漆人" width="84" />
          <el-table-column label="操作" width="200" fixed="right">
            <template #default="scope">
              <el-button link type="primary" @click="openEdit(scope.row)">编辑</el-button>
              <el-button v-if="scope.row.snapshots?.length" link type="info" @click="openHistory(scope.row)">
                旧值({{ scope.row.snapshots.length }})
              </el-button>
              <el-button link type="danger" @click="remove(scope.row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-card>
    </template>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑髹漆遍次' : '追加髹漆遍次'" width="640px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="130px">
        <el-form-item label="琴号" prop="guqinNo">
          <el-input v-model="form.guqinNo" placeholder="如：Q-2501" maxlength="20" style="width: 200px" />
        </el-form-item>
        <el-form-item label="施工来源">
          <el-radio-group v-model="form.source">
            <el-radio value="local">本坊自髹</el-radio>
            <el-radio value="outsourced">外协漆坊</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="灰胎配比">
          <el-select v-model="form.mixRatio" style="width: 200px">
            <el-option v-for="ratio in MIX_RATIOS" :key="ratio" :label="ratio" :value="ratio" />
          </el-select>
        </el-form-item>
        <el-form-item label="荫房温度(℃)">
          <el-input-number v-model="form.curingTemp" :min="5" :max="45" placeholder="荫房温度" />
        </el-form-item>
        <el-form-item label="荫房湿度(%)">
          <el-input-number v-model="form.curingHumidity" :min="30" :max="100" placeholder="荫房湿度" />
        </el-form-item>
        <el-form-item label="打磨目数">
          <el-input-number v-model="form.polishGrit" :min="80" :max="2000" :step="20" placeholder="打磨目数" />
        </el-form-item>
        <el-form-item label="本遍厚度(mm)">
          <el-input-number v-model="form.layerThickness" :min="0.01" :max="1" :step="0.01" :precision="2" placeholder="本遍厚度" />
        </el-form-item>
        <el-form-item label="施工日期">
          <el-date-picker v-model="form.appliedAt" type="date" value-format="YYYY-MM-DD" placeholder="选择日期" />
        </el-form-item>
        <el-form-item label="髹漆人" prop="operator">
          <el-input v-model="form.operator" placeholder="如：林听雪" maxlength="16" style="width: 200px" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.remark" type="textarea" :rows="2" maxlength="60" placeholder="干燥情况等" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submit">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="historyVisible" :title="`${historyLayer?.guqinNo ?? ''} 第 ${historyLayer?.seq ?? ''} 遍 · 裁决前本坊旧值`" width="640px">
      <el-alert type="info" :closable="false" show-icon class="block">
        采用外协值后旧值仍可在此查阅；每次采用外协值都会留存一条快照。
      </el-alert>
      <el-table :data="snapshots" size="small" border>
        <el-table-column label="裁决时间" width="150">
          <template #default="scope">{{ formatDate(scope.row.savedAt) }}</template>
        </el-table-column>
        <el-table-column label="方式" width="110">
          <template #default="scope">
            <el-tag size="small" :type="scope.row.resolution === 'receipt' ? 'warning' : 'success'">
              {{ scope.row.resolution === 'receipt' ? '采用外协值' : '保留本坊值' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="receiptNo" label="回执单号" width="130" />
        <el-table-column prop="layerThickness" label="旧厚度(mm)" width="100" />
        <el-table-column prop="mixRatio" label="旧配比" width="90" />
        <el-table-column label="旧施工日期" width="110">
          <template #default="scope">{{ formatDate(scope.row.appliedAt) }}</template>
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
.receipt-cell {
  display: flex;
  flex-direction: column;
  font-size: 12px;
}
.receipt-vals {
  color: #8a7a68;
}
.val-diff {
  color: #c62828;
  font-weight: 600;
}
.val-soft {
  color: #b6a997;
  font-size: 12px;
}
.val-muted {
  color: #b6a997;
  text-decoration: line-through;
}
:deep(.row-pending) {
  background: #fdf6ec;
}
</style>
