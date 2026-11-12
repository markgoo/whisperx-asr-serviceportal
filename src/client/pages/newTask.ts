/** 新建转写任务。 */

import { api, ApiError } from '../api';
import { h, fmtBytes, toast } from '../dom';
import { isAdmin, navigate, state } from '../store';
import type { Task } from '../types';

const LANGUAGES: { code: string; name: string }[] = [
  { code: '', name: '自动检测' },
  { code: 'zh', name: '中文' },
  { code: 'en', name: '英语' },
  { code: 'ja', name: '日语' },
  { code: 'ko', name: '韩语' },
  { code: 'de', name: '德语' },
  { code: 'fr', name: '法语' },
  { code: 'es', name: '西班牙语' },
  { code: 'ru', name: '俄语' },
  { code: 'pt', name: '葡萄牙语' },
  { code: 'it', name: '意大利语' },
  { code: 'ar', name: '阿拉伯语' },
  { code: 'hi', name: '印地语' },
  { code: 'th', name: '泰语' },
  { code: 'vi', name: '越南语' },
  { code: 'yue', name: '粤语' },
];

const MODELS: { value: string; label: string }[] = [
  { value: '', label: '服务器默认模型' },
  { value: 'large-v3', label: 'large-v3（最准）' },
  { value: 'large-v3-turbo', label: 'large-v3-turbo（快）' },
  { value: 'large-v2', label: 'large-v2' },
  { value: 'medium', label: 'medium' },
  { value: 'small', label: 'small' },
  { value: 'base', label: 'base' },
  { value: 'tiny', label: 'tiny（最快）' },
  { value: 'distil-large-v3', label: 'distil-large-v3' },
];

export function renderNewTask(root: HTMLElement): void {
  root.innerHTML = '';
  const settings = state.settings;
  let selectedFile: File | null = null;

  // ---- file picker -------------------------------------------------------
  const fileInput = h('input', {
    type: 'file',
    accept: 'audio/*,video/*,.m4a,.mp3,.wav,.flac,.ogg,.opus,.webm,.aac,.wma,.amr,.mkv,.mp4,.mov',
    style: 'display:none',
  }) as HTMLInputElement;

  const dzMain = h('div', { class: 'dz-main' }, '点击选择，或把录音文件拖到这里');
  const dzSub = h('div', { class: 'dz-sub' }, '支持 mp3 / wav / m4a / flac / ogg / opus / aac / wma / webm / mp4 等');
  const dropzone = h(
    'div',
    {
      class: 'dropzone',
      onclick: () => fileInput.click(),
      ondragover: (ev: Event) => {
        ev.preventDefault();
        dropzone.classList.add('drag');
      },
      ondragleave: () => dropzone.classList.remove('drag'),
      ondrop: (ev: DragEvent) => {
        ev.preventDefault();
        dropzone.classList.remove('drag');
        const f = ev.dataTransfer?.files?.[0];
        if (f) pickFile(f);
      },
    },
    h('div', { class: 'dz-icon' }, '🎙'),
    dzMain,
    dzSub,
  );

  const chipHost = h('div', { style: 'margin-top:12px' });
  function pickFile(file: File): void {
    selectedFile = file;
    chipHost.innerHTML = '';
    chipHost.appendChild(
      h(
        'div',
        { class: 'file-chip' },
        h('span', null, '🎵'),
        h('div', { style: 'min-width:0' }, h('div', { class: 'fname ellipsis' }, file.name), h('div', { class: 'fsize' }, fmtBytes(file.size))),
        h('div', { class: 'spacer', style: 'flex:1' }),
        h('button', { class: 'btn sm ghost', type: 'button', onclick: () => {
          selectedFile = null;
          fileInput.value = '';
          chipHost.innerHTML = '';
        } }, '移除'),
      ),
    );
    if (!titleInput.value.trim()) titleInput.value = file.name.replace(/\.[^.]+$/, '');
  }
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (f) pickFile(f);
  });

  // ---- fields ------------------------------------------------------------
  const titleInput = h('input', { type: 'text', placeholder: '例如：产品周会 2024-05-01' }) as HTMLInputElement;

  const diarizeToggle = h('input', {
    type: 'checkbox',
    checked: settings?.defaultDiarize ?? true,
  }) as HTMLInputElement;

  const minSpeakers = h('input', {
    type: 'number',
    min: '1',
    max: '32',
    placeholder: '不限',
    value: settings?.defaultMinSpeakers || '',
  }) as HTMLInputElement;
  const maxSpeakers = h('input', {
    type: 'number',
    min: '1',
    max: '32',
    placeholder: '不限',
    value: settings?.defaultMaxSpeakers || '',
  }) as HTMLInputElement;
  const speakerBox = h(
    'div',
    { class: 'grid cols-2', style: 'margin-top:12px' },
    h('div', { class: 'field', style: 'margin:0' }, h('label', null, '最少人数'), minSpeakers),
    h('div', { class: 'field', style: 'margin:0' }, h('label', null, '最多人数'), maxSpeakers),
  );
  const syncSpeakerBox = (): void => {
    speakerBox.style.display = diarizeToggle.checked ? '' : 'none';
  };
  diarizeToggle.addEventListener('change', syncSpeakerBox);
  syncSpeakerBox();

  const languageSelect = h(
    'select',
    null,
    ...LANGUAGES.map((l) => h('option', { value: l.code }, l.name)),
  ) as HTMLSelectElement;
  // 中英双语场景为主，默认中文可跳过语言检测、更快且更准。
  languageSelect.value = 'zh';

  const modelSelect = h(
    'select',
    null,
    ...MODELS.map((m) => h('option', { value: m.value }, m.label)),
  ) as HTMLSelectElement;
  if (settings?.defaultModel) {
    const match = MODELS.find((m) => m.value === settings.defaultModel);
    if (match) modelSelect.value = match.value;
  }

  const taskType = h(
    'select',
    null,
    h('option', { value: 'transcribe' }, '转写原文（保留原语言）'),
    h('option', { value: 'translate' }, '翻译成英文'),
  ) as HTMLSelectElement;

  const hotwords = h('input', { type: 'text', placeholder: '例如：WhisperX, 张三, OKR' }) as HTMLInputElement;
  const initialPrompt = h('textarea', { placeholder: '给模型的提示，例如：这是一段关于芯片设计的技术会议' }) as HTMLTextAreaElement;

  const progressWrap = h('div', { style: 'display:none;margin-top:14px' });
  const progressBar = h('span', { style: 'width:0%' });
  progressWrap.appendChild(h('div', { class: 'tiny muted', id: 'up-status' }, '正在上传…'));
  progressWrap.appendChild(h('div', { class: 'progress', style: 'margin-top:6px' }, progressBar));

  const submitBtn = h('button', { class: 'btn primary', type: 'submit' }, '开始转写');
  const errorBox = h('div', { class: 'alert err', style: 'display:none' });

  const form = h(
    'form',
    {
      onsubmit: async (ev: Event) => {
        ev.preventDefault();
        errorBox.style.display = 'none';
        if (!selectedFile) {
          errorBox.textContent = '请先选择要转写的音频文件';
          errorBox.style.display = '';
          return;
        }
        const minV = minSpeakers.value ? Number(minSpeakers.value) : null;
        const maxV = maxSpeakers.value ? Number(maxSpeakers.value) : null;
        if (diarizeToggle.checked && minV !== null && maxV !== null && minV > maxV) {
          errorBox.textContent = '最小说话人数不能大于最大说话人数';
          errorBox.style.display = '';
          return;
        }

        const form_ = new FormData();
        form_.append('audio', selectedFile, selectedFile.name);
        form_.append('title', titleInput.value.trim() || selectedFile.name.replace(/\.[^.]+$/, ''));
        form_.append('diarize', diarizeToggle.checked ? '1' : '0');
        if (diarizeToggle.checked) {
          if (minV !== null) form_.append('minSpeakers', String(minV));
          if (maxV !== null) form_.append('maxSpeakers', String(maxV));
        }
        if (languageSelect.value) form_.append('language', languageSelect.value);
        if (modelSelect.value) form_.append('model', modelSelect.value);
        form_.append('taskType', taskType.value);
        if (hotwords.value.trim()) form_.append('hotwords', hotwords.value.trim());
        if (initialPrompt.value.trim()) form_.append('initialPrompt', initialPrompt.value.trim());

        submitBtn.toggleAttribute('disabled', true);
        submitBtn.textContent = '上传中…';
        progressWrap.style.display = '';
        try {
          const { task } = await api.createTask(form_, (pct) => {
            progressBar.style.width = `${pct}%`;
            const el = document.getElementById('up-status');
            if (el) el.textContent = pct < 100 ? `正在上传… ${pct}%` : '上传完成，已进入队列';
          });
          toast('任务已创建，正在排队处理', 'ok');
          navigate(`/tasks/${task.id}`);
        } catch (err) {
          const msg = err instanceof ApiError ? err.message : String(err);
          errorBox.textContent = msg;
          errorBox.style.display = '';
          submitBtn.toggleAttribute('disabled', false);
          submitBtn.textContent = '开始转写';
          progressWrap.style.display = 'none';
        }
      },
    },
    errorBox,
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, '1. 选择录音文件')),
      h('div', { class: 'card-body' }, dropzone, chipHost, fileInput),
    ),
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, '2. 任务设置')),
      h(
        'div',
        { class: 'card-body' },
        h('div', { class: 'field' }, h('label', null, '任务名称'), titleInput, h('div', { class: 'hint' }, '留空则使用文件名')),
        h(
          'div',
          { class: 'field' },
          h(
            'div',
            { class: 'switch' },
            diarizeToggle,
            h(
              'div',
              null,
              h('div', { class: 'switch-text' }, '区分说话人（说话人分离）'),
              h('div', { class: 'switch-sub' }, '识别录音中不同的发言人，按人分段标注。默认开启。'),
            ),
          ),
          speakerBox,
        ),
        h(
          'div',
          { class: 'grid cols-2' },
          h('div', { class: 'field' }, h('label', null, '语言'), languageSelect, h('div', { class: 'hint' }, '指定语言比自动检测更快更准；中英混说可选「自动检测」')),
          h('div', { class: 'field' }, h('label', null, '模型'), modelSelect, h('div', { class: 'hint' }, '越大的模型越准，也越慢')),
        ),
        h(
          'details',
          { class: 'adv' },
          h('summary', null, '高级选项'),
          h(
            'div',
            { style: 'margin-top:10px' },
            h('div', { class: 'field' }, h('label', null, '任务类型'), taskType),
            h('div', { class: 'field' }, h('label', null, '热词'), hotwords, h('div', { class: 'hint' }, '人名词、专有名词，能提升识别准确率')),
            h('div', { class: 'field', style: 'margin-bottom:0' }, h('label', null, '提示词'), initialPrompt),
          ),
        ),
      ),
    ),
    h(
      'div',
      { class: 'row', style: 'margin-top:16px' },
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn', type: 'button', onclick: () => navigate('/tasks') }, '取消'),
      submitBtn,
    ),
    progressWrap,
  );

  root.appendChild(
    h(
      'div',
      null,
      h(
        'div',
        { class: 'row', style: 'margin-bottom:14px' },
        h('div', null, h('h2', { style: 'margin:0;font-size:17px' }, '新建转写任务'), h('div', { class: 'tiny muted' }, '一个录音文件即一个任务，上传后自动排队转写')),
      ),
      form,
    ),
  );
}

export type { Task };
