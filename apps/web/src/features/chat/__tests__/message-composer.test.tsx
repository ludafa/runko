import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { MessageComposer } from '../components/message-composer';

function noop(): void {
  // 这些用例不关心的那半边回调。
}

/**
 * composer 的分流键位（docs/features/steer-and-queue.md §2.1/§2.2）：一轮进行中
 * Enter = [排队](../../../../../docs/terms.md)、Alt+Enter / 插话按钮 =
 * [steer](../../../../../docs/terms.md)；空闲时两者无差别（服务端都会起新一轮），
 * 所以插话按钮只在流式中出现。
 *
 * 另一半是流式态那颗按钮的语义（docs/features/turn-abort.md §2.1）：它是
 * [停止](../../../../../docs/terms.md)键，不是排队键——排队只剩 Enter 一条路。
 */
describe('MessageComposer', () => {
  it('流式中按 Enter 走排队（intent "queue"）', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<MessageComposer onSend={onSend} onStop={noop} streaming />);

    await user.type(screen.getByRole('textbox'), '做完A再做B{Enter}');

    expect(onSend).toHaveBeenCalledExactlyOnceWith('做完A再做B', 'queue');
  });

  it('流式中按 Alt+Enter 走插话（intent "steer"）', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<MessageComposer onSend={onSend} onStop={noop} streaming />);

    await user.type(screen.getByRole('textbox'), '顺便看下超时');
    await user.keyboard('{Alt>}{Enter}{/Alt}');

    expect(onSend).toHaveBeenCalledExactlyOnceWith('顺便看下超时', 'steer');
  });

  it('流式中点插话按钮走 steer；按钮只在流式中出现', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    const { rerender } = render(
      <MessageComposer onSend={onSend} onStop={noop} streaming={false} />,
    );
    expect(screen.queryByLabelText('插入当前轮')).not.toBeInTheDocument();

    rerender(<MessageComposer onSend={onSend} onStop={noop} streaming />);
    await user.type(screen.getByRole('textbox'), '插一句');
    await user.click(screen.getByLabelText('插入当前轮'));

    expect(onSend).toHaveBeenCalledExactlyOnceWith('插一句', 'steer');
  });

  it('空闲时 Enter 照常发送（intent 在服务端无差别，仍传默认的 "queue"）', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<MessageComposer onSend={onSend} onStop={noop} streaming={false} />);

    await user.type(screen.getByRole('textbox'), '第一句{Enter}');

    expect(onSend).toHaveBeenCalledExactlyOnceWith('第一句', 'queue');
  });

  it('Shift+Enter 换行、不发送；纯空白不发送', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<MessageComposer onSend={onSend} onStop={noop} streaming />);

    const textbox = screen.getByRole('textbox');
    await user.type(textbox, '第一行{Shift>}{Enter}{/Shift}第二行');
    expect(onSend).not.toHaveBeenCalled();

    await user.clear(textbox);
    await user.type(textbox, '   {Enter}');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('发送后清空输入框', async () => {
    const user = userEvent.setup();
    render(<MessageComposer onSend={noop} onStop={noop} streaming />);

    const textbox = screen.getByRole('textbox');
    await user.type(textbox, 'hi{Enter}');

    // 输入区是 contenteditable（tiptap），没有 `value` 属性——断言的是它的文本内容
    // （docs/tech/composer-skill-mention.md §2.4）。
    expect(textbox).toHaveTextContent('');
  });

  it('流式态那颗按钮是停止键：点它走 onStop，不发消息（不是排队键）', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    const onStop = vi.fn();
    render(<MessageComposer onSend={onSend} onStop={onStop} streaming />);

    await user.type(screen.getByRole('textbox'), '打了一半的字');
    await user.click(screen.getByLabelText('停止本轮'));

    expect(onStop).toHaveBeenCalledOnce();
    // 输入框里的字既没被发出去，也没被清掉——停止与这条待发消息无关。
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox')).toHaveTextContent('打了一半的字');
  });

  it('空闲时没有停止键，只有发送键', () => {
    render(<MessageComposer onSend={noop} onStop={noop} streaming={false} />);

    expect(screen.queryByLabelText('停止本轮')).not.toBeInTheDocument();
    expect(screen.getByLabelText('发送')).toBeInTheDocument();
  });

  it('stopping 时停止键禁用（连点只发一次停止）', async () => {
    const user = userEvent.setup();
    const onStop = vi.fn();
    render(
      <MessageComposer onSend={noop} onStop={onStop} streaming stopping />,
    );

    const stop = screen.getByLabelText('停止本轮');
    expect(stop).toBeDisabled();
    await user.click(stop);
    expect(onStop).not.toHaveBeenCalled();
  });
});

/**
 * [skill 提及](../../../../../docs/terms.md)（docs/features/composer-skill-mention.md）：
 * 打 `/` 唤出[skill 清单](../../../../../docs/terms.md)、选中后插入一枚原子标记块。
 *
 * 最要紧的一条是**菜单开着时 Enter 归菜单**——composer 的 Enter 平时是排队发送，
 * 绝不能因为菜单开着就把半截消息发出去（docs/tech/composer-skill-mention.md §6.1）。
 */
describe('MessageComposer · skill 提及', () => {
  const skills = [
    { name: 'frontend-design', description: '改进现有 web 界面的视觉与交互。' },
    { name: 'code-review', description: '审查一段 diff 里的缺陷。' },
  ];

  it('打 / 弹出清单，列出全部可选 skill 及其说明', async () => {
    const user = userEvent.setup();
    render(
      <MessageComposer
        onSend={noop}
        onStop={noop}
        streaming={false}
        skills={skills}
      />,
    );

    await user.type(screen.getByRole('textbox'), '/');

    expect(await screen.findByRole('listbox')).toBeInTheDocument();
    expect(screen.getByText('/frontend-design')).toBeInTheDocument();
    expect(screen.getByText('/code-review')).toBeInTheDocument();
    expect(
      screen.getByText('改进现有 web 界面的视觉与交互。'),
    ).toBeInTheDocument();
  });

  it('继续打字即筛选，不匹配的候选消失', async () => {
    const user = userEvent.setup();
    render(
      <MessageComposer
        onSend={noop}
        onStop={noop}
        streaming={false}
        skills={skills}
      />,
    );

    await user.type(screen.getByRole('textbox'), '/front');

    expect(await screen.findByText('/frontend-design')).toBeInTheDocument();
    expect(screen.queryByText('/code-review')).not.toBeInTheDocument();
  });

  it('一个都匹配不上时菜单收起——/usr/local 这类正常输入不该被挡住', async () => {
    const user = userEvent.setup();
    render(
      <MessageComposer
        onSend={noop}
        onStop={noop}
        streaming={false}
        skills={skills}
      />,
    );

    await user.type(screen.getByRole('textbox'), '/usr');

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('筛不到候选时 Enter 仍然发送——不能被一个看不见的菜单吃掉', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(
      <MessageComposer
        onSend={onSend}
        onStop={noop}
        streaming={false}
        skills={skills}
      />,
    );

    // 关键在于 `/usr` 后面**不跟空格**：跟了空格 suggestion 会自己退出，
    // 就绕过了这个 bug。真机上正是这条路径卡住的（消息发不出去）。
    await user.type(screen.getByRole('textbox'), '/usr{Enter}');

    expect(onSend).toHaveBeenCalledExactlyOnceWith('/usr', 'queue');
  });

  it('筛不到候选时不留下空浮层（挂了容器却没内容的那种）', async () => {
    const user = userEvent.setup();
    const { baseElement } = render(
      <MessageComposer
        onSend={noop}
        onStop={noop}
        streaming={false}
        skills={skills}
      />,
    );

    await user.type(screen.getByRole('textbox'), '/usr');

    // `.react-renderer` 是 tiptap `ReactRenderer` 的容器 class——一个都不该有。
    expect(baseElement.querySelectorAll('.react-renderer')).toHaveLength(0);
  });

  it('这个会话一个 skill 都没有时：/ 不弹菜单、不挂浮层、Enter 照常发送', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    // 旧会话（本功能上线前建的）的清单就是空的，直到它下一轮起轮才刷新——
    // 这一档必须与「没这功能」时表现一致。
    const { baseElement } = render(
      <MessageComposer
        onSend={onSend}
        onStop={noop}
        streaming={false}
        skills={[]}
      />,
    );

    await user.type(screen.getByRole('textbox'), '/{Enter}');

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(baseElement.querySelectorAll('.react-renderer')).toHaveLength(0);
    expect(onSend).toHaveBeenCalledExactlyOnceWith('/', 'queue');
  });

  it('菜单开着时 Enter 选中 skill，而不是发送消息', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(
      <MessageComposer
        onSend={onSend}
        onStop={noop}
        streaming={false}
        skills={skills}
      />,
    );

    const textbox = screen.getByRole('textbox');
    await user.type(textbox, '/front');
    await screen.findByRole('listbox');
    await user.keyboard('{Enter}');

    // 这一下 Enter 归了菜单：消息没发出去，标记块进了输入框。
    expect(onSend).not.toHaveBeenCalled();
    expect(textbox).toHaveTextContent('/frontend-design');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('↓ 移动选中项后 Enter 选的是第二个', async () => {
    const user = userEvent.setup();
    render(
      <MessageComposer
        onSend={noop}
        onStop={noop}
        streaming={false}
        skills={skills}
      />,
    );

    const textbox = screen.getByRole('textbox');
    await user.type(textbox, '/');
    await screen.findByRole('listbox');
    await user.keyboard('{ArrowDown}{Enter}');

    expect(textbox).toHaveTextContent('/code-review');
  });

  it('选中后再按 Enter 才发送，发出去的文本带 /<skill 名>', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(
      <MessageComposer
        onSend={onSend}
        onStop={noop}
        streaming={false}
        skills={skills}
      />,
    );

    const textbox = screen.getByRole('textbox');
    await user.type(textbox, '/front');
    await screen.findByRole('listbox');
    await user.keyboard('{Enter}'); // 选中
    await user.type(textbox, '帮我看看首页排版');
    await user.keyboard('{Enter}'); // 发送

    expect(onSend).toHaveBeenCalledOnce();
    const [sentText, intent] = onSend.mock.calls[0] ?? [];
    // 服务端 `extractMentionedSkills` 要找的就是这个 `/<name>` 形态
    // （docs/tech/composer-skill-mention.md §5.1）。
    expect(sentText).toContain('/frontend-design');
    expect(sentText).toContain('帮我看看首页排版');
    expect(intent).toBe('queue');
  });

  it('Esc 关掉菜单后 Enter 恢复成发送', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(
      <MessageComposer
        onSend={onSend}
        onStop={noop}
        streaming={false}
        skills={skills}
      />,
    );

    await user.type(screen.getByRole('textbox'), '/front');
    await screen.findByRole('listbox');
    await user.keyboard('{Escape}');
    await user.keyboard('{Enter}');

    expect(onSend).toHaveBeenCalledOnce();
    expect(onSend.mock.calls[0]?.[0]).toBe('/front');
  });

  it('没有可选 skill 时 / 就是个普通斜杠，不弹菜单也不挡发送', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<MessageComposer onSend={onSend} onStop={noop} streaming={false} />);

    await user.type(
      screen.getByRole('textbox'),
      '/usr/local 下面有什么{Enter}',
    );

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onSend).toHaveBeenCalledExactlyOnceWith(
      '/usr/local 下面有什么',
      'queue',
    );
  });
});
