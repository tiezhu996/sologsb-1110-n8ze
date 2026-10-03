<script setup lang="ts">
import { computed } from 'vue';
import type { LacquerLayer } from '../../types/lacquer-layer';
import { curingDays } from '../../utils/layer';

const props = withDefaults(
  defineProps<{
    layers: LacquerLayer[];
    /** 参与累计厚度的遍次 id 集合；未列入者视为未决，不参与累计 */
    effectiveIds?: Set<string>;
    targetMm?: number;
    showCuring?: boolean;
  }>(),
  { effectiveIds: () => new Set<string>(), targetMm: 1, showCuring: false },
);

/** 默认（未传入 effectiveIds 时）全部遍次都参与，兼容旧调用 */
const effective = computed(() => {
  if (!props.effectiveIds || props.effectiveIds.size === 0) {
    return props.layers.map((l) => l.id);
  }
  return props.layers.map((l) => l.id).filter((id) => props.effectiveIds.has(id));
});

const effectiveSet = computed(() => new Set(effective.value));

const total = computed(() =>
  props.layers.filter((layer) => effectiveSet.value.has(layer.id)).reduce((sum, layer) => sum + (Number(layer.layerThickness) || 0), 0),
);

const segments = computed(() => {
  const sum = total.value || 1;
  return props.layers
    .filter((layer) => effectiveSet.value.has(layer.id))
    .map((layer) => ({
      layer,
      percent: Number((((Number(layer.layerThickness) || 0) / sum) * 100).toFixed(1)),
    }));
});

const progress = computed(() => Math.min(100, Math.round((total.value / (props.targetMm || 1)) * 100)));

function rowClass({ row }: { row: LacquerLayer }): string {
  return effectiveSet.value.has(row.id) ? '' : 'row-pending';
}
</script>

<template>
  <div class="layer-stack">
    <div class="stack-head">
      <span>可核销累计厚度 <b>{{ total.toFixed(2) }}</b> mm / 目标 {{ targetMm }} mm</span>
      <span class="stack-note">未决遍次以虚线标出，不参与累计</span>
    </div>
    <el-progress :percentage="progress" :stroke-width="14" :status="progress >= 100 ? 'success' : undefined" />
    <div class="stack-bar">
      <div
        v-for="segment in segments"
        :key="segment.layer.id"
        class="stack-segment"
        :style="{ width: `${segment.percent}%` }"
        :title="`第 ${segment.layer.seq} 遍 · ${segment.layer.layerThickness}mm · ${segment.layer.mixRatio}`"
      >
        <span class="stack-seq">{{ segment.layer.seq }}</span>
      </div>
    </div>
    <el-table :data="layers" size="small" border :row-class-name="rowClass">
      <el-table-column prop="seq" label="遍次" width="70" />
      <el-table-column prop="mixRatio" label="灰胎配比" width="110" />
      <el-table-column prop="layerThickness" label="本遍厚度(mm)" width="120">
        <template #default="scope">
          <span :class="{ 'val-muted': !effectiveSet.has(scope.row.id) }">{{ scope.row.layerThickness }}</span>
        </template>
      </el-table-column>
      <el-table-column label="累计厚度(mm)" width="120">
        <template #default="scope">
          <span v-if="effectiveSet.has(scope.row.id)">{{ scope.row.totalThickness?.toFixed?.(2) ?? '—' }}</span>
          <el-tag v-else type="warning" size="small">未决不计</el-tag>
        </template>
      </el-table-column>
      <el-table-column v-if="showCuring" prop="curingTemp" label="荫房温度(℃)" width="110" />
      <el-table-column v-if="showCuring" prop="curingHumidity" label="湿度(%)" width="90" />
      <el-table-column prop="polishGrit" label="打磨目数" width="100" />
      <el-table-column label="养护天数" width="100">
        <template #default="scope">{{ curingDays(scope.row) }} 天</template>
      </el-table-column>
      <el-table-column prop="operator" label="髹漆人" width="90" />
    </el-table>
  </div>
</template>

<style scoped>
.layer-stack {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.stack-head {
  display: flex;
  justify-content: space-between;
  font-size: 13px;
  color: #4a3728;
}
.stack-note {
  color: #8a7a68;
}
.stack-bar {
  display: flex;
  height: 22px;
  border-radius: 4px;
  overflow: hidden;
  border: 1px solid #ece0cf;
}
.stack-segment {
  background: #b98d55;
  color: #fff;
  font-size: 11px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-right: 1px solid #fffdf9;
}
.stack-segment:nth-child(even) {
  background: #8a6a44;
}
.stack-seq {
  opacity: 0.9;
}
.val-muted {
  color: #b6a997;
  text-decoration: line-through;
}
:deep(.row-pending) {
  background: #fdf6ec;
}
</style>
