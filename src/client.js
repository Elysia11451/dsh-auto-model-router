/**
 * dsh-auto-model-router (client half, v0.7.5).
 *
 * 浏览器半侧：只注册新槽 plugins.bundle.config（key = npm 包名），
 * 表单 scope 走 ctx.configForms.get('auto-model-router')（entry id）。
 * 15 volatile 字段经 SettingsFormModel 暂存，点保存才写入。
 * Host Config schema / apply 读取逻辑 / 状态机一律不动。
 */
window.__ModuleLoader__.load({
  id: 'dsh-auto-model-router',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    let react_jsx_runtime = require('react/jsx-runtime');
    let _primitives = require('@deepseek-ai/dsh-client-ui-primitives');

    const en = {
      title: 'Auto model router',
      description: 'Route models by session source: IM chat uses cheap owned-API models, agent work uses the strongest our-free-model at top effort.',
      enabled: 'Master switch',
      enabledHint: 'When off, the plugin only logs and never switches models.',
      priorityMode: 'Priority (manual / auto)',
      priorityModeHint: 'Manual-first: your manual selection always wins; Auto-first: routing rules win.',
      manual: 'manual',
      auto: 'auto',
      manualMode: 'manual',
      autoMode: 'auto',
      workMode: 'Work slot (manual / auto)',
      workModeHint: 'Manual: pin the model below; Auto: dynamic ranking + fallback chain.',
      manualWorkModel: 'Pinned work model',
      manualWorkModelHint: 'Only in manual work mode. Format provider/model; empty means unlocked.',
      workModelPriority: 'Work fallback chain',
      workModelPriorityHint: 'Only in auto work mode. One model per line, top first.',
      workModelFallback: 'Work last resort',
      workModelFallbackHint: 'Only in auto work mode. Last resort when the whole chain misses.',
      enableDynamicRanking: 'Dynamic ranking',
      enableDynamicRankingHint: 'Only in auto work mode. On: fetch OpenRouter ranking; off: static chain only.',
      rankingRefreshSeconds: 'Ranking refresh (s)',
      rankingRefreshSecondsHint: 'Only when auto + ranking on. 30-3600 seconds.',
      chatMode: 'Chat slot (manual / auto)',
      chatModeHint: 'Manual: pin your owned-API model below; Auto: cheapest-first chain below.',
      manualChatModel: 'Pinned chat model',
      manualChatModelHint: 'Only in manual chat mode. provider/model; empty falls back with a warning.',
      chatModelPriority: 'Chat chain (cheap first)',
      chatModelPriorityHint: 'Only in auto chat mode. One entry per line, cheapest first.',
      enableGroupHint: 'Group work-model hint',
      enableGroupHintHint: 'Off by default to avoid noise; on: one hint per group work session.',
      hintCooldownMs: 'Hint cooldown (ms)',
      hintCooldownMsHint: 'How long before the same session hints again.',
      switchCooldownMs: 'Switch cooldown (ms)',
      switchCooldownMsHint: 'Per-session switch cooldown; lower when rapid switches get swallowed.',
      reclaimUnknownModel: 'Reclaim unknown drift',
      reclaimUnknownModelHint: 'On: force unknown models back to the route target; off: leave unknown alone.',
      overridden: 'Overridden',
      reset: 'Reset to default',
      readOnly: 'This deployment stores settings read-only.',
      unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
      save: 'Save',
      saving: 'Saving…',
      saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
      saveFailedFields: 'Failed fields:',
      saveTimeout: 'Save timed out; please try again.',
      invalidNumber: 'Enter a number, or leave blank to use the default.',
      invalidValue: 'Invalid value; please correct it before saving.',
    };
    const zh = {
      title: '自动模型路由',
      description: '按会话来源路由模型：IM 聊天走便宜的自有 API 模型，Agent 干活走 our-free-model 最强模型最高档。',
      enabled: '总开关',
      enabledHint: '关闭后插件只记日志不切换模型。',
      priorityMode: '优先级（手动优先 / 路由优先）',
      priorityModeHint: '手动优先：你手动选的永远不动；路由优先：插件判该切就切。',
      manual: '手动优先',
      auto: '路由优先',
      manualMode: '手动',
      autoMode: '自动',
      workMode: '干活档（手动 / 自动）',
      workModeHint: '手动：固定用下方填的模型；自动：动态榜 + 降级链自动挑。',
      manualWorkModel: '锁定干活模型',
      manualWorkModelHint: '仅手动干活档生效。格式 provider/model，留空等于没锁。',
      workModelPriority: '干活降级链',
      workModelPriorityHint: '仅自动干活档生效。每行一个模型，越靠上越优先。',
      workModelFallback: '干活最后一兜底',
      workModelFallbackHint: '仅自动干活档生效。链上全不中时的最后一兜底。',
      enableDynamicRanking: '动态排行榜',
      enableDynamicRankingHint: '仅自动干活档生效。开：抓 OpenRouter 榜；关：纯静态链，一次请求都不发。',
      rankingRefreshSeconds: '榜单刷新间隔（秒）',
      rankingRefreshSecondsHint: '仅自动 + 开动态榜时生效。30-3600 秒。',
      chatMode: '聊天档（手动 / 自动）',
      chatModeHint: '手动：固定用下方填的自有 API 模型；自动：按下方链从便宜到贵挑。',
      manualChatModel: '锁定聊天模型',
      manualChatModelHint: '仅手动聊天档生效。格式 provider/model；留空回退兜底并打警告。',
      chatModelPriority: '聊天链（便宜优先）',
      chatModelPriorityHint: '仅自动聊天档生效。每行一个，从便宜到贵排序。',
      enableGroupHint: '群聊干活提示',
      enableGroupHintHint: '默认关（防打扰）；开后干活档群聊发一次切换提示。',
      hintCooldownMs: '提示冷却（毫秒）',
      hintCooldownMsHint: '同一会话提示过后多久内不再发。',
      switchCooldownMs: '切换冷却（毫秒）',
      switchCooldownMsHint: '同一会话连续切换冷却；切得太频繁被吞时调小。',
      reclaimUnknownModel: '未知漂移纠偏',
      reclaimUnknownModelHint: '开：当前模型两头都不认识时强制放回路由目标；关：不认识就不动。',
      overridden: '已覆盖',
      reset: '恢复默认',
      readOnly: '本部署的设置为只读。',
      unavailable: '该插件当前未加载，暂时无法配置。',
      save: '保存',
      saving: '保存中…',
      saveFailed: '本部署没有接受这些值，已保留供你修改。',
      saveFailedFields: '失败字段：',
      saveTimeout: '保存超时，请重试。',
      invalidNumber: '请填数字；留空表示使用默认值。',
      invalidValue: '值无效，保存前请先修正。',
    };
    function formLabels(t) {
      return {
        unavailable: t('unavailable'),
        readOnly: t('readOnly'),
        saveFailed: t('saveFailed'),
        save: t('save'),
        saving: t('saving'),
      };
    }

    // —— 手写 spec（primitives 只 ship number/text；boolean/union/array 照 {field,format,parse} 自写）——
    function booleanField(field) {
      return {
        field,
        format: (v) => (typeof v === 'boolean' ? (v ? 'true' : 'false') : ''),
        parse: (text) => {
          const s = String(text ?? '').trim().toLowerCase();
          if (s === '') return { kind: 'clear' };
          if (s === 'true' || s === '1') return { kind: 'set', value: true };
          if (s === 'false' || s === '0') return { kind: 'set', value: false };
          return void 0;
        },
      };
    }
    function unionField(field, allowed) {
      return {
        field,
        format: (v) => (typeof v === 'string' ? v : ''),
        parse: (text) => {
          const s = String(text ?? '').trim();
          if (s === '') return { kind: 'clear' };
          return allowed.indexOf(s) >= 0 ? { kind: 'set', value: s } : void 0;
        },
      };
    }
    function arrayLinesField(field) {
      return {
        field,
        format: (v) => (Array.isArray(v) ? v.join('\n') : ''),
        parse: (text) => {
          const s = String(text ?? '');
          if (s.trim() === '') return { kind: 'clear' };
          return { kind: 'set', value: s.split('\n').map((x) => x.trim()).filter(Boolean) };
        },
      };
    }

    const MODE_OPTIONS = ['manual', 'auto'];

    function boolRow(jsx, t, props, state, field, disabled) {
      const st = state[field];
      const checked = st.text === 'true';
      return jsx('div', {
        key: field,
        style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 },
        children: [
          jsx(_primitives.Switch, {
            key: field + '-sw',
            checked,
            disabled,
            label: t(field),
            onChange: (next) => { props.edit(field, next ? 'true' : 'false'); },
          }),
          jsx('span', {
            key: field + '-lb',
            children: t(field),
          }),
          st.overridden ? jsx('button', {
            key: field + '-rs',
            type: 'button',
            disabled,
            onClick: () => { props.resetField(field); },
            children: t('reset'),
          }) : null,
          st.invalid ? jsx('span', { key: field + '-inv', children: t('invalidValue') }) : null,
        ],
      });
    }
    function unionRow(jsx, t, props, state, field, disabled) {
      const st = state[field];
      const isPriority = field === 'priorityMode';
      return jsx('div', {
        key: field,
        style: { marginBottom: 12 },
        children: [
          jsx('label', {
            key: field + '-lb',
            htmlFor: 'plugin-config-router-' + field,
            children: t(field),
          }),
          jsx('select', {
            key: field + '-sel',
            id: 'plugin-config-router-' + field,
            value: st.text,
            disabled,
            onChange: (e) => { props.edit(field, e.target.value); },
            children: MODE_OPTIONS.map((v) => {
              const label = isPriority ? t(v) : t(v === 'manual' ? 'manualMode' : 'autoMode');
              return jsx('option', { key: v, value: v, children: label }, v);
            }),
          }),
          st.overridden ? jsx('button', {
            key: field + '-rs',
            type: 'button',
            disabled,
            onClick: () => { props.resetField(field); },
            children: t('reset'),
          }) : null,
          st.invalid ? jsx('p', { key: field + '-inv', children: t('invalidValue') }) : null,
        ],
      });
    }
    function arrayRow(jsx, t, props, state, field, disabled) {
      const st = state[field];
      return jsx('div', {
        key: field,
        style: { marginBottom: 12 },
        children: [
          jsx('label', {
            key: field + '-lb',
            htmlFor: 'plugin-config-router-' + field,
            children: t(field),
          }),
          jsx('textarea', {
            key: field + '-ta',
            id: 'plugin-config-router-' + field,
            value: st.text,
            rows: 3,
            disabled,
            style: { width: '100%', boxSizing: 'border-box', resize: 'vertical' },
            onChange: (e) => { props.edit(field, e.target.value); },
          }),
          st.overridden ? jsx('button', {
            key: field + '-rs',
            type: 'button',
            disabled,
            onClick: () => { props.resetField(field); },
            children: t('reset'),
          }) : null,
          st.invalid ? jsx('p', { key: field + '-inv', children: t('invalidValue') }) : null,
        ],
      });
    }
    function textRow(jsx, t, props, state, field, disabled, numeric) {
      const st = state[field];
      return jsx(_primitives.SettingsValueField, {
        key: field,
        id: 'plugin-config-router-' + field,
        label: t(field),
        hint: t(field + 'Hint'),
        overriddenLabel: t('overridden'),
        resetLabel: t('reset'),
        invalidLabel: numeric ? t('invalidNumber') : t('invalidValue'),
        numeric: numeric === true,
        disabled,
        ...st,
        onEdit: (text) => { props.edit(field, text); },
        onReset: () => { props.resetField(field); },
      });
    }

    function RouterConfigView(props) {
      const { t } = props;
      const state = props.useRouterCard((snapshot) => snapshot);
      if (props.view === 'summary') return t('description');
      const jsx = react_jsx_runtime.jsx;
      const jsxs = react_jsx_runtime.jsxs;
      const disabled = !state.writable;
      const failedExtra = state.failed && (state.failedFields?.length || state.saveError)
        ? jsx('p', {
          key: 'save-failed-fields',
          role: 'status',
          children: (state.saveError === 'timeout' ? t('saveTimeout') + ' ' : '')
            + t('saveFailedFields') + ' ' + (state.failedFields || []).join(', '),
        })
        : null;
      return jsxs('div', {
        key: 'router-config-wrap',
        children: [
          failedExtra,
          jsx(_primitives.SettingsForm, {
            key: 'router-config-form',
            labels: formLabels(t),
            state,
            onSave: props.save,
            onDiscard: props.discard,
            children: jsxs('div', {
              children: [
                boolRow(jsx, t, props, state, 'enabled', disabled),
                unionRow(jsx, t, props, state, 'priorityMode', disabled),
                unionRow(jsx, t, props, state, 'workMode', disabled),
                textRow(jsx, t, props, state, 'manualWorkModel', disabled, false),
                arrayRow(jsx, t, props, state, 'workModelPriority', disabled),
                textRow(jsx, t, props, state, 'workModelFallback', disabled, false),
                boolRow(jsx, t, props, state, 'enableDynamicRanking', disabled),
                textRow(jsx, t, props, state, 'rankingRefreshSeconds', disabled, true),
                unionRow(jsx, t, props, state, 'chatMode', disabled),
                textRow(jsx, t, props, state, 'manualChatModel', disabled, false),
                arrayRow(jsx, t, props, state, 'chatModelPriority', disabled),
                boolRow(jsx, t, props, state, 'enableGroupHint', disabled),
                textRow(jsx, t, props, state, 'hintCooldownMs', disabled, true),
                textRow(jsx, t, props, state, 'switchCooldownMs', disabled, true),
                boolRow(jsx, t, props, state, 'reclaimUnknownModel', disabled),
              ],
            }),
          }),
        ],
      });
    }

    const ENTRY_NS = 'auto-model-router';
    // 保存串行队列 + 看门狗（社区 PR #114 / 22fee9d 口径）：
    // 绝不重叠两次 scope.mutate()；失败/超时必复位 saving。
    const SAVE_TIMEOUT_MS = 5000;
    var RouterCardController = class {
      form;
      store;
      saving = false;
      saveQueued = false;
      failed = false;
      failedFields = [];
      saveError = '';
      saveTimer = null;
      /** @param scope - the shared configuration form of the auto-model-router entry. */
      constructor(scope) {
        this.form = new _primitives.SettingsFormModel(scope, [
          booleanField('enabled'),
          unionField('priorityMode', MODE_OPTIONS),
          unionField('workMode', MODE_OPTIONS),
          (0, _primitives.settingsTextField)('manualWorkModel'),
          arrayLinesField('workModelPriority'),
          (0, _primitives.settingsTextField)('workModelFallback'),
          booleanField('enableDynamicRanking'),
          (0, _primitives.settingsNumberField)('rankingRefreshSeconds'),
          unionField('chatMode', MODE_OPTIONS),
          (0, _primitives.settingsTextField)('manualChatModel'),
          arrayLinesField('chatModelPriority'),
          booleanField('enableGroupHint'),
          (0, _primitives.settingsNumberField)('hintCooldownMs'),
          (0, _primitives.settingsNumberField)('switchCooldownMs'),
          booleanField('reclaimUnknownModel'),
        ]);
        this.store = this.form.bind(() => this.projection());
      }
      projection() {
        return {
          ...this.form.shell(),
          saving: this.saving || this.form.shell().saving,
          failed: this.failed || this.form.shell().failed,
          failedFields: this.failedFields,
          saveError: this.saveError,
          enabled: this.form.field('enabled'),
          priorityMode: this.form.field('priorityMode'),
          workMode: this.form.field('workMode'),
          manualWorkModel: this.form.field('manualWorkModel'),
          workModelPriority: this.form.field('workModelPriority'),
          workModelFallback: this.form.field('workModelFallback'),
          enableDynamicRanking: this.form.field('enableDynamicRanking'),
          rankingRefreshSeconds: this.form.field('rankingRefreshSeconds'),
          chatMode: this.form.field('chatMode'),
          manualChatModel: this.form.field('manualChatModel'),
          chatModelPriority: this.form.field('chatModelPriority'),
          enableGroupHint: this.form.field('enableGroupHint'),
          hintCooldownMs: this.form.field('hintCooldownMs'),
          switchCooldownMs: this.form.field('switchCooldownMs'),
          reclaimUnknownModel: this.form.field('reclaimUnknownModel'),
        };
      }
      planFields() {
        try {
          return this.form.plan().map((item) => item.field).filter(Boolean);
        } catch (_e) {
          return [];
        }
      }
      armSaveTimer() {
        this.clearSaveTimer();
        this.saveTimer = setTimeout(() => {
          this.saveTimer = null;
          this.saving = false;
          this.failed = true;
          this.saveError = 'timeout';
          try { this.form.saving = false; this.form.failed = true; } catch (_e) {}
          this.publish();
          if (this.saveQueued) {
            this.saveQueued = false;
            this.saveNow();
          }
        }, SAVE_TIMEOUT_MS);
      }
      clearSaveTimer() {
        if (this.saveTimer) {
          clearTimeout(this.saveTimer);
          this.saveTimer = null;
        }
      }
      publish() {
        try { this.form.publish(); } catch (_e) {}
      }
      async saveNow() {
        const fields = this.planFields();
        this.saving = true;
        this.failed = false;
        this.failedFields = [];
        this.saveError = '';
        this.armSaveTimer();
        this.publish();
        let ok = false;
        try {
          const r = this.form.save();
          if (r && typeof r.then === 'function') await r;
          // SettingsFormModel.save() 无返回值：以落盘后状态判定
          // 成功 = 内层 failed 为假且待写计划已清空；守卫拦截（非法值/空计划）计划仍非空→判失败
          let innerFailed = false;
          let remain = 0;
          try { innerFailed = !!this.form.shell().failed; } catch (_e) {}
          try { remain = this.form.plan().length; } catch (_e) {}
          ok = !innerFailed && remain === 0;
          if (!ok && !innerFailed && remain === 0) ok = true; // 空计划守卫：无事可存也算成功
        } catch (_e) {
          ok = false;
        }
        this.clearSaveTimer();
        this.saving = false;
        if (ok) {
          this.failed = false;
          this.failedFields = [];
          this.saveError = '';
        } else {
          this.failed = true;
          this.failedFields = fields.length ? fields : this.planFields();
          if (!this.saveError) this.saveError = 'rejected';
          try { this.form.failed = true; } catch (_e) {}
        }
        try { this.form.saving = false; } catch (_e) {}
        this.publish();
        if (this.saveQueued) {
          this.saveQueued = false;
          this.saveNow();
        }
      }
      /**
       * 串行 save：保存中再按只排队，不重叠 mutate。
       */
      save() {
        if (this.saving) {
          this.saveQueued = true;
          return;
        }
        this.saveNow();
      }
      discard() {
        this.saveQueued = false;
        this.clearSaveTimer();
        this.saving = false;
        this.failed = false;
        this.failedFields = [];
        this.saveError = '';
        try { this.form.discard(); } catch (_e) {}
        this.publish();
      }
      /**
       * Build the face the bundle config slot registration injects.
       * @returns the page's snapshot and its form actions.
       */
      inject() {
        const base = this.form.actions();
        return {
          hooks: { routerCard: this.store },
          edit: base.edit,
          resetField: base.resetField,
          save: () => this.save(),
          discard: () => this.discard(),
        };
      }
      /** Release the form subscription. */
      dispose() {
        this.saveQueued = false;
        this.clearSaveTimer();
        this.form.dispose();
      }
    };

    const NS = 'settings.autoModelRouter';
    const inject = ['slots', 'locale', 'configForms'];
    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-auto-model-router: dictionaries');
      const card = new RouterCardController(ctx.configForms.get(ENTRY_NS));
      ctx.effect(() => () => {
        card.dispose();
      }, 'ui-auto-model-router: form subscriptions');
      ctx.effect(
        () => ctx.configForms.whileServed([ENTRY_NS], () =>
          ctx.slots.inject('plugins.bundle.config', () =>
            ctx.slots.register({
              name: 'plugins.bundle.config',
              key: 'dsh-auto-model-router',
              order: 100,
              label: () => t('title'),
              locale: NS,
              inject: () => card.inject(),
            }, RouterConfigView))),
        'ui-auto-model-router: bundle config page',
      );
    }
    exports.NS = NS;
    exports.ENTRY_NS = ENTRY_NS;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
