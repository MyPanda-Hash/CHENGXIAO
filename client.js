/**
 * dsh-peer-mcp — browser half.
 *
 * A "设备互联" section in the Web UI settings page. It does the three things an
 * operator needs an actual interface for, because relaying them through the
 * model is both awkward and slower:
 *
 *   1. Turn the inbound listener on or off.
 *   2. Issue a one-time pairing code and hand it over.
 *   3. See the machines that may drive this one, and revoke them.
 *
 * Everything with authority lives on the host: this file only calls the
 * plugin's own routes and renders what comes back. No secret is stored here —
 * the pairing code exists in component state for as long as it takes to read it
 * out, and a status refresh never carries one.
 *
 * Hand-written ModuleLoader bundle — the shape the Web UI requires of a
 * plugin's client half (same contract as dsh-tool-vision and dsh-skill-auto).
 * The host serves these bytes to the page as a classic script and never imports
 * the file in Node, so everything lives inside one `factory(require)` closure:
 * executing the file only REGISTERS the factory, and every side effect —
 * including CSS — happens when the host materializes it. `require` resolves the
 * page module table, which is where `react` comes from; `fetch` is all the
 * plugin itself needs beyond that.
 */
window.__ModuleLoader__.load({
  id: "dsh-peer-mcp",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");
    var h = react.createElement;

    /** Class prefix, so nothing here can collide with another plugin's styles. */
    var NS = "dsh-peer-mcp";
    var css = function (name) {
      return NS + "__" + name;
    };

    /** The routes the host registers for this page. */
    var API = {
      status: "/plugins/dsh-peer-mcp/status",
      ticket: "/plugins/dsh-peer-mcp/ticket",
      pair: "/plugins/dsh-peer-mcp/pair",
      revoke: "/plugins/dsh-peer-mcp/revoke",
      workspace: "/plugins/dsh-peer-mcp/workspace",
    };

    var inject = ["slots", "locale"];

    /** Style sheet, injected once per mount. Scoped by the class prefix. */
    var STYLES = [
      "." + NS + "{--pcm-fg:var(--foreground,#111);--pcm-dim:var(--muted-foreground,#6b7280);",
      "--pcm-line:var(--border,#e5e7eb);--pcm-raised:var(--muted,rgba(0,0,0,.03));",
      "--pcm-ok:#15803d;--pcm-warn:#b45309;--pcm-bad:#b91c1c;",
      "display:flex;flex-direction:column;gap:20px;font-size:13px;color:var(--pcm-fg);}",
      "." + NS + " h3{margin:0 0 2px;font-size:14px;font-weight:600;letter-spacing:-.01em;}",
      "." + NS + " p{margin:0;line-height:1.55;color:var(--pcm-dim);text-wrap:pretty;}",
      "." + CSSGROUP() + "{display:flex;flex-direction:column;gap:10px;}",
      "." + css("head") + "{display:flex;align-items:baseline;gap:8px;justify-content:space-between;}",
      "." + css("state") + "{display:inline-flex;align-items:center;gap:6px;font-variant-numeric:tabular-nums;white-space:nowrap;}",
      "." + css("dot") + "{width:7px;height:7px;border-radius:50%;background:var(--pcm-dim);flex:none;}",
      "[data-state=on] ." + css("dot") + "{background:var(--pcm-ok);}",
      "[data-state=off] ." + css("dot") + "{background:var(--pcm-dim);}",
      "." + css("mono") + "{font-family:var(--font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);",
      "font-variant-numeric:tabular-nums;font-size:12px;}",
      "." + css("card") + "{border:1px solid var(--pcm-line);border-radius:10px;padding:12px 14px;background:var(--pcm-raised);}",
      "." + css("row") + "{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}",
      "." + css("grow") + "{flex:1 1 220px;min-width:0;}",
      "." + css("code") + "{font-size:15px;letter-spacing:.08em;padding:8px 10px;border-radius:8px;",
      "border:1px dashed var(--pcm-line);background:var(--background,transparent);user-select:all;cursor:text;}",
      "." + css("link") + "{display:block;word-break:break-all;user-select:all;cursor:text;font-size:12px;color:var(--pcm-dim);}",
      "." + css("button") + "{appearance:none;border:1px solid var(--pcm-line);background:var(--background,transparent);",
      "color:inherit;font:inherit;padding:8px 14px;border-radius:8px;cursor:pointer;",
      "min-height:40px;transition-property:background-color,border-color,transform;transition-duration:120ms;transition-timing-function:ease-out;}",
      "." + css("button") + ":hover:not(:disabled){background:var(--pcm-raised);}",
      "." + css("button") + ":active:not(:disabled){transform:scale(.97);}",
      "." + css("button") + ":disabled{opacity:.5;cursor:default;}",
      "." + css("button") + ":focus-visible{outline:2px solid var(--pcm-fg);outline-offset:2px;}",
      "." + css("primary") + "{border-color:transparent;background:var(--pcm-fg);color:var(--background,#fff);}",
      "." + css("danger") + "{color:var(--pcm-bad);}",
      "." + css("input") + "{flex:1 1 260px;min-width:0;font:inherit;padding:9px 10px;border-radius:8px;",
      "border:1px solid var(--pcm-line);background:var(--background,transparent);color:inherit;min-height:40px;}",
      "." + css("input") + ":focus-visible{outline:2px solid var(--pcm-fg);outline-offset:1px;}",
      "." + css("list") + "{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none;}",
      "." + css("item") + "{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 12px;",
      "border:1px solid var(--pcm-line);border-radius:10px;}",
      "." + css("item") + "[data-revoked]{opacity:.55;}",
      "." + css("name") + "{font-weight:600;}",
      "." + css("tag") + "{font-size:11px;line-height:1.6;padding:1px 7px;border-radius:999px;border:1px solid var(--pcm-line);",
      "color:var(--pcm-dim);white-space:nowrap;}",
      "." + css("tag") + "[data-preset=danger-full-access]{color:var(--pcm-warn);border-color:currentColor;}",
      "." + css("note") + "{font-size:12px;}",
      "." + css("note") + "[data-tone=ok]{color:var(--pcm-ok);}",
      "." + css("note") + "[data-tone=error]{color:var(--pcm-bad);}",
      "." + css("cap") + "{display:flex;flex-wrap:wrap;gap:6px;}",
      "." + css("cap") + " ." + css("tag") + "[data-cap=on]{color:var(--pcm-ok);border-color:currentColor;}",
      "." + css("cap") + " ." + css("tag") + "[data-cap=off]{color:var(--pcm-dim);}",
      "." + css("empty") + "{padding:14px;border:1px dashed var(--pcm-line);border-radius:10px;text-align:center;color:var(--pcm-dim);font-size:12px;}",
    ].join("");

    /** Style sheet needs one grouped rule; kept out of the array for readability. */
    function CSSGROUP() {
      return css("group");
    }

    /**
     * Call one of the plugin's routes.
     *
     * @param {string} path - route path.
     * @param {object} [init] - fetch options.
     * @returns {Promise<object>} the JSON body, with `status` attached as `httpStatus`.
     */
    function call(path, init) {
      return fetch(path, init).then(function (response) {
        return response
          .json()
          .catch(function () {
            return {};
          })
          .then(function (body) {
            body.httpStatus = response.status;
            return body;
          });
      });
    }

    /** Read the machine's peer state. */
    var readStatus = function () {
      return call(API.status, { headers: { Accept: "application/json" } });
    };

    /**
     * Render the panel.
     *
     * @param {{ props?: object }} context - slot props supplied by the host.
     * @returns {object} the React element.
     */
    function PeerSection(props) {
      var [status, setStatus] = react.useState(null);
      var [ticket, setTicket] = react.useState(null);
      var [link, setLink] = react.useState("");
      var [preset, setPreset] = react.useState("workspace-write");
      var [note, setNote] = react.useState(null);
      var [busy, setBusy] = react.useState(false);
      var [workspacePath, setWorkspacePath] = react.useState("");

      var refresh = react.useCallback(function () {
        return readStatus()
          .then(function (next) {
            setStatus(next);
          })
          .catch(function (cause) {
            setNote({ tone: "error", text: String(cause && cause.message ? cause.message : cause) });
          });
      }, []);

      react.useEffect(function () {
        refresh();
      }, [refresh]);

      /** Run one action, then refresh; failures surface as a note, never a crash. */
      var run = react.useCallback(
        function (action, done) {
          setBusy(true);
          setNote(null);
          return action()
            .then(function (result) {
              if (result && result.ok === false) {
                setNote({ tone: "error", text: result.detail || result.code });
                return result;
              }
              return refresh().then(function () {
                if (done) done(result);
                return result;
              });
            })
            .catch(function (cause) {
              setNote({ tone: "error", text: String(cause && cause.message ? cause.message : cause) });
            })
            .then(function () {
              setBusy(false);
            });
        },
        [refresh],
      );

      var onTicket = function () {
        run(
          function () {
            return call(API.ticket, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ preset: preset }),
            });
          },
          function (result) {
            setTicket(result);
            setNote({ tone: "ok", text: "配对码已生成。把它交给另一台机器，有效期 15 分钟，用过即废。" });
          },
        );
      };

      var onPair = function () {
        run(function () {
          return call(API.pair, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ link: link }),
          });
        }).then(function (result) {
          if (result && result.ok === true) {
            setLink("");
            setNote({
              tone: "ok",
              text:
                result.mounted === false
                  ? "已配对，但对端尚未可调用：" + JSON.stringify(result.mountError || {})
                  : "配对成功，对端工具已可用。",
            });
          }
          return result;
        });
      };

      var onRevoke = function (id) {
        run(function () {
          return call(API.revoke, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: id }),
          });
        }, function () {
          setNote({ tone: "ok", text: "已撤销。该机器的凭据立即失效。" });
        });
      };

      var onSaveWorkspace = function () {
        var path = workspacePath.trim();
        if (path === "") return;
        run(function () {
          return call(API.workspace, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path: path }),
          });
        }, function (result) {
          if (result && result.ok === true) {
            setNote({ tone: "ok", text: "共享工作区已更新。" });
          }
        });
      };

      if (status === null) {
        return h("div", { className: NS }, h("p", null, "正在读取设备互联状态…"));
      }

      var listening = status.listening === true;
      var trustedBy = status.trustedBy || [];
      var peers = status.peers || [];

      return h(
        "div",
        { className: NS },
        h("style", null, STYLES),

        // ── listener ──────────────────────────────────────────────────────────
        h(
          "section",
          { className: css("group") },
          h(
            "div",
            { className: css("head") },
            h("h3", null, "本机监听"),
            h(
              "span",
              { className: css("state"), "data-state": listening ? "on" : "off" },
              h("span", { className: css("dot"), "aria-hidden": "true" }),
              listening ? "已对外监听" : "未监听",
            ),
          ),
          h(
            "p",
            null,
            listening
              ? "其他机器可以连接到本机。只有持有配对码并通过配对的机器才能执行任务。"
              : "本机不对外监听，因此没有任何机器能连进来。要配对必须先开启监听——这一项只能在这里改，模型无法替你打开。",
          ),
          listening && status.address
            ? h("p", { className: css("mono") }, "地址：" + status.address)
            : null,
          h(
            "p",
            { className: css("note") },
            "开启/关闭监听需要改 profile 配置并重启 DSH；这里是只读状态。",
          ),
        ),

        // ── shared workspace ──────────────────────────────────────────────────
        h(
          "section",
          { className: css("group") },
          h("h3", null, "共享工作区"),
          h(
            "p",
            null,
            "对端机器只能在这个目录里读写文件和执行任务，工作区之外一律拒绝。",
          ),
          status.workspace
            ? h(
                "div",
                { className: css("row") },
                h("span", { className: css("mono") + " " + css("grow") }, status.workspace.path),
                h(
                  "span",
                  { className: css("tag") },
                  status.workspace.source === "configured" ? "自定义" : "默认",
                ),
              )
            : null,
          h(
            "div",
            { className: css("row") },
            h("input", {
              className: css("input") + " " + css("mono"),
              type: "text",
              value: workspacePath,
              placeholder: "输入要共享的绝对目录…",
              spellCheck: false,
              "aria-label": "共享工作区路径",
              onChange: function (event) {
                setWorkspacePath(event.target.value);
              },
            }),
            h(
              "button",
              {
                type: "button",
                className: css("button"),
                disabled: busy || workspacePath.trim() === "",
                onClick: onSaveWorkspace,
              },
              "保存工作区",
            ),
          ),
          h(
            "p",
            { className: css("note") },
            "默认是用户目录下的 DSH Workspace；保存后立即生效，旧配置自动迁移。",
          ),
          status.capabilities
            ? h(
                "div",
                { className: css("cap") },
                h("h3", null, "对端权限"),
                h(
                  "span",
                  { className: css("tag"), "data-cap": status.capabilities.readWorkspace ? "on" : "off" },
                  "读取工作区",
                ),
                h(
                  "span",
                  { className: css("tag"), "data-cap": status.capabilities.writeWorkspace ? "on" : "off" },
                  "写入工作区",
                ),
                h(
                  "span",
                  { className: css("tag"), "data-cap": status.capabilities.runTask ? "on" : "off" },
                  "执行任务",
                ),
                h(
                  "span",
                  { className: css("tag"), "data-cap": status.capabilities.transferFiles ? "on" : "off" },
                  "传输文件",
                ),
                h(
                  "span",
                  { className: css("tag"), "data-cap": status.capabilities.runSystemCommand ? "on" : "off" },
                  "系统命令",
                ),
                h(
                  "span",
                  { className: css("tag"), "data-cap": status.capabilities.accessOutsideWorkspace ? "on" : "off" },
                  "工作区外访问",
                ),
                h(
                  "span",
                  { className: css("tag"), "data-cap": status.capabilities.modifyDshConfig ? "on" : "off" },
                  "修改 DSH 配置",
                ),
              )
            : null,
        ),

        // ── pairing code ──────────────────────────────────────────────────────
        h(
          "section",
          { className: css("group") },
          h("h3", null, "发配对码"),
          h("p", null, "生成一个一次性配对码，交给另一台机器。"),
          h(
            "div",
            { className: css("row") },
            h(
              "select",
              {
                className: css("input"),
                value: preset,
                disabled: busy || !listening,
                onChange: function (event) {
                  setPreset(event.target.value);
                },
                "aria-label": "授予对端的权限档位",
              },
              h("option", { value: "workspace-write" }, "工作区协作（默认，推荐）"),
              h("option", { value: "danger-full-access" }, "完全控制（高级，不推荐）"),
            ),
            h(
              "button",
              {
                type: "button",
                className: css("button") + " " + css("primary"),
                disabled: busy || !listening,
                onClick: onTicket,
              },
              "生成配对码",
            ),
          ),
          ticket
            ? h(
                "div",
                { className: css("card") },
                h("p", { className: css("code") + " " + css("mono") }, ticket.shortCode || ticket.code),
                h("p", { className: css("note") }, "完整链接（另一台机器直接粘贴这一行）："),
                h("span", { className: css("link") + " " + css("mono") }, ticket.link),
                h(
                  "p",
                  { className: css("note") },
                  "权限档位：" + ticket.preset + "　·　到期：" + new Date(ticket.expiresAt).toLocaleTimeString(),
                ),
              )
            : null,
        ),

        // ── claim a code ──────────────────────────────────────────────────────
        h(
          "section",
          { className: css("group") },
          h("h3", null, "连接另一台机器"),
          h("p", null, "粘贴对方给出的配对链接，本机就会成为可调用它的一方。"),
          h(
            "div",
            { className: css("row") },
            h("input", {
              className: css("input") + " " + css("mono"),
              type: "text",
              value: link,
              placeholder: "dshp://192.168.1.20:7331/XXXXX-XXXXX",
              spellCheck: false,
              "aria-label": "配对链接",
              onChange: function (event) {
                setLink(event.target.value);
              },
            }),
            h(
              "button",
              {
                type: "button",
                className: css("button"),
                disabled: busy || link.trim() === "",
                onClick: onPair,
              },
              "配对",
            ),
          ),
          peers.length > 0
            ? h(
                "ul",
                { className: css("list") },
                peers.map(function (peer) {
                  return h(
                    "li",
                    { className: css("item"), key: peer.id },
                    h("span", { className: css("name") }, peer.name),
                    h("span", { className: css("tag") + " " + css("mono") }, peer.address),
                    h("span", { className: css("tag") }, "本机可调用它"),
                  );
                }),
              )
            : h("p", { className: css("empty") }, "尚未连接其他机器。"),
        ),

        // ── who may drive this machine ────────────────────────────────────────
        h(
          "section",
          { className: css("group") },
          h("h3", null, "被允许驱动本机的机器"),
          h(
            "p",
            null,
            "下面每一台都可以在本机的目录白名单内执行任务、读写文件。撤销后凭据立即失效。",
          ),
          trustedBy.length === 0
            ? h("p", { className: css("empty") }, "还没有任何机器被授权。")
            : h(
                "ul",
                { className: css("list") },
                trustedBy.map(function (peer) {
                  var revoked = peer.revokedAt !== undefined;
                  return h(
                    "li",
                    { className: css("item"), key: peer.id, "data-revoked": revoked ? "" : undefined },
                    h("span", { className: css("grow") }, h("span", { className: css("name") }, peer.name)),
                    h("span", { className: css("tag"), "data-preset": peer.preset }, peer.preset),
                    revoked
                      ? h("span", { className: css("tag") }, "已撤销")
                      : h(
                          "button",
                          {
                            type: "button",
                            className: css("button") + " " + css("danger"),
                            disabled: busy,
                            onClick: function () {
                              onRevoke(peer.id);
                            },
                          },
                          "撤销",
                        ),
                  );
                }),
              ),
        ),

        note ? h("p", { className: css("note"), "data-tone": note.tone, role: "status" }, note.text) : null,
      );
    }

    /**
     * Mount the section into the settings page.
     *
     * @param {object} ctx - the client context.
     * @returns {void}
     */
    function apply(ctx) {
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register(
          {
            name: "settings.section",
            id: "dsh-peer-mcp",
            order: 42,
            label: function () {
              return "设备互联";
            },
          },
          function (props) {
            return h(PeerSection, props);
          },
        );
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
