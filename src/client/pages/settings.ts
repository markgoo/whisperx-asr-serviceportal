/** 系统设置（管理员）。 */

import { api } from '../api';
import { h, toast } from '../dom';
import { state } from '../store';
import type { AsrHealth, Settings } from '../types';

export async function renderSettings(root: HTMLElement): Promise<void> {
  root.innerHTML = '';
  root.appendChild(h('div', { class: 'muted' }, '加载中…'));

  let settings: Settings;
  try {
    settings = (await api.getSettings()).settings;
  } catch (err) {
    root.innerHTML = '';
    root.appendChild(h('div', { class: 'alert err' }, err instanceof Error ? err.message : String(err)));
    return;
  }
  state.settings = settings;
  root.innerHTML = '';

  // ---- ASR backend -------------------------------------------------------
  const asrUrl = h('input', { type: 'text', value: settings.asrBaseUrl }) as HTMLInputElement;
  const asrTimeout = h('input', {
    type: 'number',
    min: '30',
    value: String(settings.asrTimeoutSec),
  }) as HTMLInputElement;
  const defaultModel = h('input', {
    type: 'text',
    value: settings.defaultModel,
    placeholder: '留空使用服务端默认模型（如 large-v3）',
  }) as HTMLInputElement;
  const defaultDiarize = h('input', { type: 'checkbox', checked: settings.defaultDiarize }) as HTMLInputElement;
  const defaultMin = h('input', { type: 'number', min: '1', value: settings.defaultMinSpeakers }) as HTMLInputElement;
  const defaultMax = h('input', { type: 'number', min: '1', value: settings.defaultMaxSpeakers }) as HTMLInputElement;

  const healthBox = h('div', { class: 'tiny muted' }, '未检测');

  const checkHealth = async (): Promise<void> => {
    healthBox.innerHTML = '';
    healthBox.appendChild(document.createTextNode('检测中…'));
    try {
      const health: AsrHealth = await api.asrHealth();
      healthBox.innerHTML = '';
      if (health.reachable) {
        healthBox.appendChild(
          h(
            'span',
            null,
            h('span', { class: 'badge-pill ok' }, '连接正常'),
            ` ${health.latencyMs ?? '?'} ms · 设备 ${health.device || '未知'}`,
          ),
        );
      } else {
        healthBox.appendChild(
          h('span', null, h('span', { class: 'badge-pill err' }, '无法连接'), ` ${health.error || ''}`),
        );
      }
    } catch (err) {
      healthBox.textContent = err instanceof Error ? err.message : String(err);
    }
  };

  const asrCard = h(
    'div',
    { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', null, 'ASR 服务')), 
    h(
      'div',
      { class: 'card-body' },
      h(
        'div',
        { class: 'field' },
        h('label', null, '服务地址'),
        asrUrl,
        h('div', { class: 'hint' }, 'WhisperX 服务的根地址，例如 http://127.0.0.1:9000'),
      ),
      h(
        'div',
        { class: 'field' },
        h('label', null, '请求超时（秒）'),
        asrTimeout,
        h('div', { class: 'hint' }, '长录音转写很慢，建议保持较大的值'),
      ),
      h('div', { class: 'field' }, h('label', null, '默认模型'), defaultModel),
      h(
        'div',
        { class: 'row', style: 'margin-top:6px' },
        h('button', { class: 'btn sm', onclick: () => void checkHealth() }, '测试连接'),
        healthBox,
      ),
    ),
  );

  // ---- 标点服务 ----------------------------------------------------------
  const puncUrl = h('input', {
    type: 'text',
    value: settings.puncServiceUrl || '',
    placeholder: 'http://127.0.0.1:9001（留空则不使用）',
  }) as HTMLInputElement;
  const puncEnabled = h('input', { type: 'checkbox', checked: settings.puncEnabled }) as HTMLInputElement;
  const puncHealthBox = h('div', { class: 'tiny muted' }, '未检测');

  const checkPuncHealth = async (): Promise<void> => {
    puncHealthBox.innerHTML = '';
    puncHealthBox.appendChild(document.createTextNode('检测中…'));
    try {
      const health = await api.puncHealth();
      puncHealthBox.innerHTML = '';
      if (!health.configured) {
        puncHealthBox.appendChild(h('span', { class: 'badge-pill warn' }, '未配置'));
        return;
      }
      if (health.reachable) {
        puncHealthBox.appendChild(
          h(
            'span',
            null,
            h('span', { class: 'badge-pill ok' }, '已连接'),
            ` ${health.latencyMs ?? '?'} ms · ${health.model || 'ct-punc'} · ${health.device || 'cpu'}`,
          ),
        );
      } else {
        puncHealthBox.appendChild(
          h('span', null, h('span', { class: 'badge-pill err' }, '无法连接'), ` ${health.error || ''}`),
        );
      }
    } catch (err) {
      puncHealthBox.textContent = err instanceof Error ? err.message : String(err);
    }
  };

  const puncCard = h(
    'div',
    { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', null, '标点恢复服务')),
    h(
      'div',
      { class: 'card-body' },
      h(
        'div',
        { class: 'alert info', style: 'font-size:12.5px' },
        '内置的规则式标点只能靠断句规则猜；接一个 CT-Transformer 标点模型，',
        '句号和逗号的位置会准得多（实测同一段 106 字，规则式出 3 个标点，模型出 9 个且位置正确）。',
      ),
      h(
        'div',
        { class: 'switch', style: 'margin-bottom:14px' },
        puncEnabled,
        h(
          'div',
          null,
          h('div', { class: 'switch-text' }, '启用模型标点'),
          h('div', { class: 'switch-sub' }, '服务不可用时自动退回内置规则，不影响转写'),
        ),
      ),
      h(
        'div',
        { class: 'field', style: 'margin-bottom:0' },
        h('label', null, '服务地址'),
        puncUrl,
        h('div', { class: 'hint' }, '对应 docker/punc-service 容器，默认监听 9001'),
      ),
      h(
        'div',
        { class: 'row', style: 'margin-top:10px' },
        h('button', { class: 'btn sm', onclick: () => void checkPuncHealth() }, '测试连接'),
        puncHealthBox,
      ),
    ),
  );

  // ---- defaults ----------------------------------------------------------
  const defaultsCard = h(
    'div',
    { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', null, '新任务默认值')),
    h(
      'div',
      { class: 'card-body' },
      h(
        'div',
        { class: 'switch', style: 'margin-bottom:14px' },
        defaultDiarize,
        h(
          'div',
          null,
          h('div', { class: 'switch-text' }, '默认勾选「区分说话人」'),
          h('div', { class: 'switch-sub' }, '新建任务时说话人分离选项的默认状态'),
        ),
      ),
      h(
        'div',
        { class: 'grid cols-2' },
        h('div', { class: 'field', style: 'margin-bottom:0' }, h('label', null, '默认为最少人数'), defaultMin),
        h('div', { class: 'field', style: 'margin-bottom:0' }, h('label', null, '默认为最多人数'), defaultMax),
      ),
    ),
  );

  // ---- storage -----------------------------------------------------------
  const quota = h('input', { type: 'number', min: '0', value: String(settings.storageQuotaMb) }) as HTMLInputElement;
  const retain = h('input', { type: 'number', min: '0', value: String(settings.storageRetainDays) }) as HTMLInputElement;
  const storageCard = h(
    'div',
    { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', null, '存储')),
    h(
      'div',
      { class: 'card-body' },
      h(
        'div',
        { class: 'field' },
        h('label', null, '单个用户/全局容量上限（MB）'),
        quota,
        h('div', { class: 'hint' }, '0 表示不限制。达到上限后新的上传会被拒绝。'),
      ),
      h(
        'div',
        { class: 'field', style: 'margin-bottom:0' },
        h('label', null, '自动清理保留天数'),
        retain,
        h('div', { class: 'hint' }, '0 表示不自动清理。可在存储页手动按时间清理。'),
      ),
    ),
  );

  // ---- 转写结果修正 ------------------------------------------------------
  const normEnabled = h('input', { type: 'checkbox', checked: settings.normalizeEnabled }) as HTMLInputElement;
  const normS2T = h('input', { type: 'checkbox', checked: settings.normalizeToSimplified }) as HTMLInputElement;
  const normTerms = h(
    'textarea',
    {
      placeholder: '每行一条，格式：错误写法=正确写法\n例如：\nHPM=HBM\n海靈獅=海力士\n英偉塔=英伟达',
      style: 'min-height:120px;font-family:ui-monospace,Consolas,monospace;font-size:12.5px',
    },
  ) as HTMLTextAreaElement;
  normTerms.value = settings.normalizeTerms || '';

  const normCard = h(
    'div',
    { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', null, '转写结果修正')),
    h(
      'div',
      { class: 'card-body' },
      h(
        'div',
        { class: 'alert info', style: 'font-size:12.5px' },
        'whisper 在中文模式下会把英文缩写拆成单个字母（A I / G P U），并且常混入繁体。',
        h('br'),
        '这里开启的修正会在转写完成后自动执行。提示词（prompt/hotwords）不推荐使用——会在长录音的静音段被“续写”进正文。',
      ),
      h(
        'div',
        { class: 'switch', style: 'margin-bottom:14px' },
        normEnabled,
        h(
          'div',
          null,
          h('div', { class: 'switch-text' }, '启用结果修正'),
          h('div', { class: 'switch-sub' }, '合并拆开的英文缩写（A I → AI）、应用下方术语词典、整理标点'),
        ),
      ),
      h(
        'div',
        { class: 'switch', style: 'margin-bottom:14px' },
        normS2T,
        h(
          'div',
          null,
          h('div', { class: 'switch-text' }, '繁体转简体'),
          h('div', { class: 'switch-sub' }, '把「覺得台灣」自动转成「觉得台湾」'),
        ),
      ),
      h(
        'div',
        { class: 'field', style: 'margin-bottom:0' },
        h('label', null, '自定义术语词典'),
        normTerms,
        h('div', { class: 'hint' }, '内置词典已覆盖常见硬件/人名错词。这里只需补充你自己的专有名词。'),
      ),
    ),
  );

  const saveBtn = h(
    'button',
    {
      class: 'btn primary',
      onclick: async () => {
        saveBtn.toggleAttribute('disabled', true);
        try {
          const res = await api.saveSettings({
            asrBaseUrl: asrUrl.value.trim(),
            asrTimeoutSec: Number(asrTimeout.value) || 7200,
            defaultModel: defaultModel.value.trim(),
            defaultDiarize: defaultDiarize.checked,
            defaultMinSpeakers: defaultMin.value,
            defaultMaxSpeakers: defaultMax.value,
            storageQuotaMb: Number(quota.value) || 0,
            storageRetainDays: Number(retain.value) || 0,
            puncServiceUrl: puncUrl.value.trim(),
            puncEnabled: puncEnabled.checked,
            normalizeEnabled: normEnabled.checked,
            normalizeToSimplified: normS2T.checked,
            normalizeTerms: normTerms.value,
          } as never);
          state.settings = res.settings;
          toast('设置已保存', 'ok');
        } catch (err) {
          toast(err instanceof Error ? err.message : String(err), 'err');
        } finally {
          saveBtn.toggleAttribute('disabled', false);
        }
      },
    },
    '保存设置',
  );

  root.appendChild(
    h(
      'div',
      null,
      h(
        'div',
        { style: 'margin-bottom:16px' },
        h('h2', { style: 'margin:0;font-size:17px' }, '系统设置'),
        h('div', { class: 'tiny muted' }, '这些设置对所有用户生效'),
      ),
      asrCard,
      defaultsCard,
      puncCard,
      normCard,
      storageCard,
      h('div', { class: 'row', style: 'margin-top:16px' }, h('div', { class: 'spacer' }), saveBtn),
    ),
  );

  void checkHealth();
  void checkPuncHealth();
}
