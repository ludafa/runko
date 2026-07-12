import { setConfig } from '@kubb/plugin-client/clients/fetch';

setConfig({
  baseURL: '',
  headers: {
    'Content-Type': 'application/json',
  },
  credentials: 'include',
});
