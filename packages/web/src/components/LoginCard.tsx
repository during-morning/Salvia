import type { Item } from '../api.ts';

/** Asked when an unavailable result is opened: log in (here, or on a shared server's console). */
export function LoginCard({ item, server, onBrowser, onPaste, onCancel }: { item: Item; server: boolean; onBrowser: () => void; onPaste: () => void; onCancel: () => void }) {
  return (
    <div className="card login" role="alertdialog" aria-label="需要登录">
      <h3>需要登录</h3>
      <p>
        "{item.title}"{item.locked?.reason ?? '暂时无法获取'}。
        {server ? '这是共享的服务端，网页上不能登录；需要时请在服务端控制台用 @login 登录。' : '登录你自己的账号后，可获取账号有权限的内容。'}
      </p>
      <div className="actions">
        {!server && (
          <>
            <button className="pill dark" onClick={onBrowser}>
              浏览器登录
            </button>
            <button className="pill" onClick={onPaste}>
              粘贴 Cookie
            </button>
          </>
        )}
        <button className="pill" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}
