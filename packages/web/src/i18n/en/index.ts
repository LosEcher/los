import { enCore } from './core';
import { enChat } from './chat';
import { enWork } from './work';
import { enPages } from './pages';
import { enOps } from './ops';
import { enOps2 } from './ops2';
import { enAssets } from './assets';
import { enAssets2 } from './assets2';

export const en: Record<string, string> = {
  ...enCore,
  ...enChat,
  ...enWork,
  ...enPages,
  ...enOps,
  ...enOps2,
  ...enAssets,
  ...enAssets2,
};
