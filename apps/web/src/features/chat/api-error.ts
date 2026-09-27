/**
 * chat 接口的错误类型，单独一个模块：组件只要认错误、不发请求时，从这里引，测试 mock 掉 `./api`
 * 也不会把它一起弄没。
 */
export class ChatApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(
      message.length > 0 ?
        message
      : `chat API request failed with status ${String(status)}`,
    );
    this.name = 'ChatApiError';
    this.status = status;
  }
}
