const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// A deliberately small DOM for controller/rendering regressions. Layout and
// browser-specific accessibility still require an actual webview inspection.
class Element {
  constructor(tag, document) {
    this.tagName = tag;
    this.ownerDocument = document;
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.listeners = new Map();
    this.className = "";
    this.disabled = false;
    this._text = "";
    this.classList = {
      toggle: (value, enabled) => {
        const classes = new Set(this.className.split(/\s+/).filter(Boolean));
        if (enabled) classes.add(value); else classes.delete(value);
        this.className = [...classes].join(" ");
      },
    };
  }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(""); }
  set textContent(value) { this._text = String(value); this.replaceChildren(); }
  set innerHTML(_value) { throw new Error("Unsafe HTML rendering is not supported by this fixture."); }
  append(...nodes) {
    for (const node of nodes) { node.parentElement = this; this.children.push(node); }
  }
  replaceChildren(...nodes) {
    for (const node of this.children) node.parentElement = null;
    this.children = [];
    this.append(...nodes);
  }
  setAttribute(key, value) {
    this.attributes.set(key, String(value));
    if (key === "class") this.className = String(value);
    if (key.startsWith("data-")) this.dataset[key.slice(5).replace(/-([a-z])/g, (_all, char) => char.toUpperCase())] = String(value);
    if (key === "disabled") this.disabled = true;
  }
  getAttribute(key) {
    if (key === "class") return this.className;
    if (key.startsWith("data-")) return this.dataset[key.slice(5).replace(/-([a-z])/g, (_all, char) => char.toUpperCase())] ?? null;
    return this.attributes.get(key) ?? null;
  }
  removeAttribute(key) { this.attributes.delete(key); }
  matches(selector) {
    const match = selector.match(/^([a-z][\w-]*)?(?:\.([\w-]+))?(?:\[([\w-]+)(?:=["']?([^"'\]]+)["']?)?\])?$/i);
    if (!match) throw new Error("Unsupported test selector: " + selector);
    const [, tag, className, attribute, value] = match;
    return (!tag || this.tagName === tag) && (!className || this.className.split(/\s+/).includes(className))
      && (!attribute || (this.getAttribute(attribute) !== null && (value === undefined || this.getAttribute(attribute) === value)));
  }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
  focus() { this.ownerDocument.activeElement = this; }
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(callback);
  }
  fire(type, target = this, extra = {}) {
    const event = { target, preventDefault() {}, ...extra };
    for (const callback of this.listeners.get(type) || []) callback(event);
  }
}

function webviewHTML() {
  const root = path.resolve(__dirname, "../..");
  const box = { module: { exports: {} }, require: (name) => name === "vscode"
    ? { Uri: { joinPath: (base, ...segments) => path.join(base, ...segments) } } : require(name) };
  vm.runInNewContext(fs.readFileSync(path.join(root, "src/webview.js"), "utf8"), box);
  return box.module.exports.getWebviewHTML({ cspSource: "vscode-resource:", asWebviewUri: (value) => "vscode-resource:" + value }, root);
}

function dashboardFixture(savedState = {}) {
  const document = new Element("document");
  document.ownerDocument = document;
  document.createElement = (tag) => new Element(tag, document);
  document.createElementNS = (_namespace, tag) => new Element(tag, document);
  document.getElementById = (id) => {
    const visit = (node) => node.getAttribute("id") === id ? node : node.children.map(visit).find(Boolean);
    return visit(document);
  };
  const stack = [document];
  for (const token of webviewHTML().match(/<[^>]*>|[^<]+/g)) {
    if (token.startsWith("<!")) continue;
    if (token.startsWith("</")) { stack.pop(); continue; }
    if (token.startsWith("<")) {
      const tag = token.match(/^<([\w-]+)/)[1];
      const node = document.createElement(tag);
      const attributes = token.slice(tag.length + 1, -1);
      for (const match of attributes.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) node.setAttribute(match[1], match[2] ?? "");
      stack.at(-1).append(node);
      if (!["meta", "link", "hr", "br", "input"].includes(tag)) stack.push(node);
    } else stack.at(-1)._text += token;
  }
  const messages = [];
  let state = savedState;
  const window = new Element("window", document);
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, "../../media/dashboard.js"), "utf8"), {
    document, window,
    acquireVsCodeApi: () => ({
      getState: () => state,
      setState: (value) => { state = JSON.parse(JSON.stringify(value)); },
      postMessage: (value) => messages.push(JSON.parse(JSON.stringify(value))),
    }),
  });
  return {
    document, messages, get state() { return state; },
    receive: (snapshot) => window.fire("message", window, { data: snapshot }),
    click: (id) => document.getElementById(id).fire("click"),
    date: (key) => document.querySelector('button[data-date="' + key + '"]'),
  };
}

module.exports = { dashboardFixture, webviewHTML };
