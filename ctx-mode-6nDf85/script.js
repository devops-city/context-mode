
const TurndownService = require("/Users/mksglu/Server/Mert/context-mode-claude-code-plugin/context-mode/node_modules/turndown/lib/turndown.cjs.js");
const { gfm } = require("/Users/mksglu/Server/Mert/context-mode-claude-code-plugin/context-mode/node_modules/turndown-plugin-gfm/lib/turndown-plugin-gfm.cjs.js");
const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
td.use(gfm);
td.remove(['script', 'style', 'nav', 'header', 'footer', 'noscript']);
console.log(td.turndown("<style>body { color: red; }</style><header><nav>Menu</nav></header><main><p>Content</p></main><footer>Footer</footer><noscript>Enable JS</noscript>"));
