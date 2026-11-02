#!/usr/bin/env node
// Legacy path of the permission hook. Up to 0.2.0, `npm run hooks:install` saved this file in the accounts'
// settings.json; the script moved to mod/habblaud-permissoes/hooks/permission-hook.mjs (habblaud-permissoes plugin).
// This shortcut keeps those installations working after `git pull`, until `npm run mod:install` (which removes
// the old hook) or a new `npm run hooks:install` replaces them. Pure Node, no dependencies.
import { main } from '../mod/habblaud-permissoes/hooks/permission-hook.mjs';

main().catch(() => process.exit(0));
