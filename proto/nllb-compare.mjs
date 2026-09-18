import { pipeline, env } from '@huggingface/transformers';

env.allowLocalModels = false;

const SENTENCES = [
  '全新正品 2024款 男士休闲运动鞋 透气防滑 轻便舒适',
  '包邮 顺丰发货 七天无理由退换 支持货到付款',
  '这款面料柔软亲肤，弹力好，适合春秋季节穿着',
  '库存紧张，最后三件，拍下即发',
  '亲，这个尺码建议您比平时大一码哦',
  '产品参数：材质 聚酯纤维；重量 约 280 克；产地 广东',
  '买家秀：物流很快，质量不错，就是颜色比图片稍微深一点'
];

// The browser cannot load fp32 NLLB at all, so this runs in node purely to find
// out what the quantization the browser forces on us is actually costing.
const results = {};

for (const dtype of ['q8', 'fp32']) {
  process.stderr.write(`\n=== loading ${dtype}\n`);
  const started = Date.now();
  let translate;
  try {
    translate = await pipeline('translation', 'Xenova/nllb-200-distilled-600M', {
      dtype,
      progress_callback: (p) => {
        if (p.status === 'progress' && p.progress === 100) {
          process.stderr.write(`  fetched ${p.file}\n`);
        }
      }
    });
  } catch (e) {
    console.log(`${dtype}: FAILED — ${e.message}`);
    continue;
  }
  process.stderr.write(`  loaded in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);

  results[dtype] = [];
  for (const sentence of SENTENCES) {
    const t = Date.now();
    const [{ translation_text: text }] = await translate(sentence, {
      src_lang: 'zho_Hans',
      tgt_lang: 'eng_Latn',
      max_new_tokens: 128
    });
    results[dtype].push({ text, ms: Date.now() - t });
    process.stderr.write('.');
  }
  process.stderr.write('\n');
  try { await translate.dispose(); } catch {}
}

console.log('\n\n================ NLLB-200-distilled-600M: q8 vs fp32 ================\n');
SENTENCES.forEach((sentence, i) => {
  console.log(`源  ${sentence}`);
  for (const dtype of ['q8', 'fp32']) {
    const r = results[dtype]?.[i];
    console.log(`${dtype.padEnd(4)} ${r ? `${String(r.ms).padStart(5)}ms  ${r.text}` : '(not run)'}`);
  }
  console.log();
});

for (const dtype of Object.keys(results)) {
  const ms = results[dtype].map((r) => r.ms).sort((a, b) => a - b);
  console.log(`${dtype}: median ${ms[(ms.length - 1) >> 1]}ms`);
}
