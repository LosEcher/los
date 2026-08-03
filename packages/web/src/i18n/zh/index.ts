import { zhCore } from './core';
import { zhChat } from './chat';
import { zhWork } from './work';
import { zhPages } from './pages';
import { zhOps } from './ops';
import { zhOps2 } from './ops2';
import { zhAssets } from './assets';
import { zhAssets2 } from './assets2';

export const zh: Record<string, string> = {
  ...zhCore,
  ...zhChat,
  ...zhWork,
  ...zhPages,
  ...zhOps,
  ...zhOps2,
  ...zhAssets,
  ...zhAssets2,
};
