/**
 * [composer](../../../../../docs/terms.md) 的输入区（docs/tech/composer-skill-mention.md §5.3/§6）。
 *
 * 从 `<textarea>` 换成 tiptap，**只为一件事**：拿到「原子节点」这个能力——一枚删得
 * 干净、选得整体、不会被拆成半截字符的[skill 提及](../../../../../docs/terms.md)标记
 * 块。textarea 里 `/frontend-design` 就是 17 个可以任意删改的字符，做不出这个。
 *
 * **不开放任何富文本格式**（tech §2.4）：只装 Document + Paragraph + Text +
 * HardBreak + Placeholder + Mention 六个扩展，不装 starter-kit，粘贴一律走纯文本。
 * 理由是用户消息最终要落成 `NimboUIMessage` 的一条 text part，任何富文本格式都
 * 无处可去，做出来只会是骗人的。
 *
 * ---- 两处结构性的选择 ----
 *
 * **① editor 只创建一次，所有会变的东西走一个「最新值盒子」。** `useEditor` 的
 * extensions 数组若随 render 重建，整个 ProseMirror 文档会被重建、光标丢失。所以
 * `onSubmit` / `skills` / `placeholder` 这些每次 render 都可能是新值的东西，一律
 * 存进 `live`（见 `LiveComposerState`）由扩展闭包读——扩展本身在组件生命周期内
 * 保持同一个对象。
 *
 * **② 菜单是否打开由本组件自己记一个开关，不依赖插件顺序。** 「菜单开着时 Enter
 * 归菜单、不发消息」是本功能回归风险最高的一条（tech §6.1）。tiptap 的 suggestion
 * 确实会在 ProseMirror 层先吃掉按键，但那依赖 plugin 注册顺序——这里在
 * `onStart`/`onExit` 里自己记一个开关（`liveRef.current.suggestionOpen`），Enter 快捷键先查它
 * 再决定要不要发送，双保险。
 */
import { Extension } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import HardBreak from '@tiptap/extension-hard-break';
import Mention from '@tiptap/extension-mention';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { Placeholder } from '@tiptap/extensions';
import { EditorContent, ReactRenderer, useEditor } from '@tiptap/react';
import type {
  SuggestionKeyDownProps,
  SuggestionProps,
} from '@tiptap/suggestion';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';

import type { SkillSummary } from '@/features/chat/schema';
import type { SendIntent } from '@/features/chat/use-chat-messages';

import type {
  SkillSuggestionListHandle,
  SkillSuggestionListProps,
} from './skill-suggestion-list';
import { SkillSuggestionList } from './skill-suggestion-list';

/** 唤出 [skill 清单](../../../../../docs/terms.md)的触发键。`@` 留给将来的文件引用，本次不实现。 */
const TRIGGER_CHAR = '/';

export interface ComposerEditorProps {
  /** 受控的**纯文本**形态——标记块在这里就是 `/<name>` 字面量。 */
  value: string;
  onChange: (text: string) => void;
  /** Enter = [排队](../../../../../docs/terms.md)，⌥⏎ = [中途插话](../../../../../docs/terms.md)。 */
  onSubmit: (intent: SendIntent) => void;
  skills: readonly SkillSummary[];
  placeholder: string;
}

/** 菜单里显示哪些候选：按名字模糊筛（大小写不敏感），最多 8 条。 */
function filterSkills(
  skills: readonly SkillSummary[],
  query: string,
): SkillSummary[] {
  const needle = query.trim().toLowerCase();
  const matched =
    needle.length === 0 ?
      [...skills]
    : skills.filter((skill) => skill.name.toLowerCase().includes(needle));
  return matched.slice(0, 8);
}

/** 扩展闭包读得到的「最新值盒子」（见文件头 ①/②，以及 `ComposerEditor` 里的 lint 说明）。 */
interface LiveComposerState {
  onChange: (text: string) => void;
  onSubmit: (intent: SendIntent) => void;
  skills: readonly SkillSummary[];
  placeholder: string;
  /** 见文件头 ②：菜单开着时 Enter 归菜单，不发消息。 */
  suggestionOpen: boolean;
}

export function ComposerEditor({
  value,
  onChange,
  onSubmit,
  skills,
  placeholder,
}: ComposerEditorProps) {
  const liveRef = useRef<LiveComposerState>({
    onChange,
    onSubmit,
    skills,
    placeholder,
    suggestionOpen: false,
  });

  // 更新放在 layout effect 里（不是 render 期间）——扩展闭包只在用户真正打字/按键时
  // 读它，那一刻 effect 早已跑过，读到的必然是最新一次 render 的值。
  useLayoutEffect(() => {
    liveRef.current.onChange = onChange;
    liveRef.current.onSubmit = onSubmit;
    liveRef.current.skills = skills;
    liveRef.current.placeholder = placeholder;
  }, [onChange, onSubmit, skills, placeholder]);

  // 下面这段整体关掉 `react-hooks/refs`——这是标准的 "latest ref" 模式，与规则想防的
  // 问题正好相反。规则担心「render 期间读到过期的 ref 值」；这里 useMemo 的回调只是
  // **把 ref 对象捕获进闭包**，`.current` 的实际读取全部发生在用户敲键盘、tiptap
  // 回调触发的那一刻，早已不在 render 期间。
  //
  // 之所以非这么写不可：`useEditor` 的 extensions 必须在 render 期间就位，而它一旦
  // 重建，整个 ProseMirror 文档跟着重建、光标丢失（见文件头 ①）。扩展必须稳定，稳定
  // 的扩展又必须能读到最新的 props——两者之间只有 ref 这一条路。
  /* eslint-disable react-hooks/refs */
  const extensions = useMemo(
    () => [
      Document,
      Paragraph,
      Text,
      HardBreak,
      Placeholder.configure({
        placeholder: () => liveRef.current.placeholder,
      }),
      Mention.configure({
        // 只加样式类，**不覆盖 `renderHTML`**：Mention 默认的 renderHTML 会输出
        // `<span data-type="mention" data-id="...">`，而它的 `parseHTML` 正是照这个
        // 形状找回来的。自己写一版 renderHTML 会打破这对称性——复制一段带标记块的
        // 文字再粘回来，就解析不回 mention 节点、退化成普通文字了。
        HTMLAttributes: {
          class:
            'rounded bg-primary/10 text-primary px-1 py-0.5 text-[0.9em] font-medium',
        },
        // Backspace 删掉标记块后**不留触发字符**。默认（false）会回填一个 `/`，那会
        // 立刻把菜单重新弹出来——「删掉」变成「又打开了」，很怪。真机上还暴露过更
        // 糟的一面：回填用的是节点自己的 `mentionSuggestionChar` 属性，而这个属性要
        // 靠插入节点时显式带上（见下面 command 里的 attrs），漏了就回填成默认的 `@`
        // ——删掉一个 `/frontend-design` 竟然凭空冒出个 `@`。
        deleteTriggerWithBackspace: true,
        // 节点里只存 skill 名；转纯文本时把触发键补回去，让
        // `editor.getText()` 得到的正是服务端 `extractMentionedSkills` 要找的
        // `/<name>` 形态。默认的 renderHTML 也用它渲染块内文字，所以屏幕上显示的
        // 和发出去的文本天然是同一份，不会对不上。
        renderText: ({ node }) =>
          `${TRIGGER_CHAR}${String(node.attrs.id ?? '')}`,
        suggestion: {
          char: TRIGGER_CHAR,
          items: ({ query }) => filterSkills(liveRef.current.skills, query),
          // 覆盖 `suggestion` 就等于替换掉 Mention 自带的那份默认配置（configure
          // 是浅合并），所以 command 要自己写：把 `/` + 已打的筛选词整段换成一个
          // mention 节点，后面补个空格，光标自然落在标记块之后。
          command: ({ editor, range, props }) => {
            editor
              .chain()
              .focus()
              .insertContentAt(range, [
                {
                  type: 'mention',
                  // `mentionSuggestionChar` 必须显式带上：Mention 内部好几处（Backspace
                  // 回填、默认 renderHTML/renderText）读的是**节点自己**的这个属性，
                  // 而不是 suggestion 配置里的 `char`。漏了就退回默认的 `@`。
                  attrs: { ...props, mentionSuggestionChar: TRIGGER_CHAR },
                },
                { type: 'text', text: ' ' },
              ])
              .run();
          },
          render: () => {
            // 泛型参数是**组件自己的 props**，不是 `SuggestionProps`：tiptap 传下来
            // 的那个大对象里，本组件只用 `items`/`command` 两项，其余（editor/range/
            // query/...）多带无害，结构上兼容。
            let component: ReactRenderer<
              SkillSuggestionListHandle,
              SkillSuggestionListProps
            > | null = null;
            let unmount: (() => void) | null = null;

            /**
             * 收起菜单，并**把键盘还给 composer**。
             *
             * `suggestionOpen` 必须跟着这里一起翻回 false：它决定 Enter 归菜单还是
             * 归发送，挂在「菜单是不是真的显示着」上，不能挂在「suggestion 插件是不是
             * 激活着」上——两者不是一回事，见下面 `sync` 的说明。
             */
            const hide = (): void => {
              liveRef.current.suggestionOpen = false;
              unmount?.();
              unmount = null;
              component?.destroy();
              component = null;
            };

            /**
             * `onStart` 与 `onUpdate` 共用一条路径：**有候选才挂载，没候选就收起**。
             *
             * 这条分支是必需的，不是优化。suggestion 插件只要看见触发键就会激活，
             * 哪怕一个候选都没有（这个会话还没装 skill，或者用户打的是 `/usr` 这种
             * 普通路径）。此时若照样挂载，会有两个后果，都在真机上踩到过：
             *
             * 1. body 下多出一个**空的** `.react-renderer` 浮层——组件自己在
             *    `items.length === 0` 时返回 `null`，但容器 div 已经挂上去了。
             * 2. 更要命：`suggestionOpen` 被置成 true，于是 Enter 被一个根本看不见的
             *    菜单吃掉，**消息发不出去**。打 `/usr` 再回车就会卡住。
             */
            const sync = (props: SuggestionProps<SkillSummary>): void => {
              if (props.items.length === 0) {
                hide();
                return;
              }
              if (component === null) {
                const renderer = new ReactRenderer(SkillSuggestionList, {
                  props,
                  editor: props.editor,
                });
                component = renderer;
                // tiptap 3 的 suggestion 自带托管定位（`props.mount` 负责挂载 +
                // 跟随锚点），不需要 tippy.js / floating-ui（tech §6.2）。
                unmount = props.mount?.(renderer.element) ?? null;
              } else {
                component.updateProps(props);
              }
              liveRef.current.suggestionOpen = true;
            };

            return {
              onStart: sync,
              onUpdate: sync,
              onKeyDown: (props: SuggestionKeyDownProps): boolean => {
                if (props.event.key === 'Escape') {
                  hide();
                  return true;
                }
                return component?.ref?.onKeyDown(props) ?? false;
              },
              onExit: hide,
            };
          },
        },
      }),
      Extension.create({
        name: 'composerSubmitShortcuts',
        addKeyboardShortcuts() {
          return {
            // 菜单开着时让路（此时 Enter 是「选中这个 skill」，绝不能发消息）。
            Enter: () => {
              if (liveRef.current.suggestionOpen) {
                return false;
              }
              liveRef.current.onSubmit('queue');
              return true;
            },
            'Alt-Enter': () => {
              if (liveRef.current.suggestionOpen) {
                return false;
              }
              liveRef.current.onSubmit('steer');
              return true;
            },
            'Shift-Enter': () => this.editor.commands.setHardBreak(),
          };
        },
      }),
    ],
    [],
  );
  /* eslint-enable react-hooks/refs */

  const editor = useEditor({
    extensions,
    content: '',
    editorProps: {
      attributes: {
        class:
          'max-h-48 min-h-10 w-full resize-none overflow-y-auto bg-transparent px-3 py-2.5 text-sm outline-none',
        // `InputGroup` 靠这个属性给整个外框加聚焦高亮
        // （`has-[[data-slot=input-group-control]:focus-visible]:border-ring`）。
        // 真正获得焦点的是这个 contenteditable，所以属性必须挂在它身上，不能挂
        // 在 `EditorContent` 的外层 div 上。
        'data-slot': 'input-group-control',
        'aria-label': '消息输入框',
        role: 'textbox',
      },
    },
    onUpdate: ({ editor: instance }) => {
      liveRef.current.onChange(instance.getText({ blockSeparator: '\n' }));
    },
  });

  // 见 tech §6.4：**只**处理「外部把 value 清空了而编辑器里还有内容」这一种同步
  // 方向（发送成功后的清空）。不做每次按键的反向灌入——那会在每个字符上重建文档、
  // 丢掉光标位置。
  useEffect(() => {
    if (editor === null) {
      return;
    }
    if (value !== '') {
      return;
    }
    if (editor.getText({ blockSeparator: '\n' }) === '') {
      return;
    }
    editor.commands.clearContent();
  }, [editor, value]);

  // `w-full` 是**必需**的，不是装饰：`PromptInputBody` 是 `display: contents`，所以
  // 这个 div 直接参与 `InputGroup` 的 flex 布局；而 `InputGroup` 一旦带上 block-end
  // 的工具条就变成 `flex-col` + `items-center`——纵向 flex 下 `items-center` 会把子项
  // 宽度收缩到 fit-content，空编辑器的 fit-content 约等于 0，输入框就成了一条点不着、
  // 聚不了焦的缝。原来的 textarea 不出这个问题，是因为 shadcn 的 `Textarea` 基础类
  // 自带 `w-full`（`InputGroupTextarea` 只补了 `flex-1`）。
  //
  // jsdom 测不出这个：它没有布局引擎，宽度恒为 0，`user.type` 照样把事件派发到元素上，
  // 所以 composer 的全部键位用例在这个 bug 下依然全绿。只有真浏览器能验（施工文档
  // §5.2 第 11 项）。
  return <EditorContent editor={editor} className="w-full flex-1" />;
}
