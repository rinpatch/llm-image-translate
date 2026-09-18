import { pipeline, env } from '@huggingface/transformers';

env.allowLocalModels = false;

const SENTENCES = [
  '全新正品 2024款 男士休闲运动鞋 透气防滑 轻便舒适',
  '包邮 顺丰发货 七天无理由退换 支持货到付款',
  '这款面料柔软亲肤，弹力好，适合春秋季节穿着'
];

for (const dtype of ['fp32', 'q8']) {
  console.log(`\n===== Xenova/opus-mt-zh-en  dtype=${dtype}`);
  let translate;
  try {
    translate = await pipeline('translation', 'Xenova/opus-mt-zh-en', { dtype });
  } catch (e) {
    console.log('  load failed:', e.message);
    continue;
  }
  for (const sentence of SENTENCES) {
    const started = Date.now();
    const [{ translation_text: text }] = await translate(sentence, { max_new_tokens: 128 });
    const words = text.trim().split(/\s+/);
    const ratio = new Set(words).size / words.length;
    console.log(`  ${Date.now() - started}ms  unique=${ratio.toFixed(2)}  ${JSON.stringify(text.slice(0, 160))}`);
  }
}
