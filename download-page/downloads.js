const OSS_BASE = "https://trainwise.oss-cn-beijing.aliyuncs.com/deckwise/";
const links = [...document.querySelectorAll("[data-file]")];
const errorBox = document.querySelector("#load-error");
const metaLabels = new Map([...document.querySelectorAll("[data-meta]")].map((node) => [node, node.textContent]));

async function loadDownloads() {
  errorBox.hidden = true;
  document.querySelector("#release-date").textContent = "正在获取版本信息";
  for (const link of links) {
    link.removeAttribute("href");
    link.setAttribute("aria-disabled", "true");
  }
  try {
    const response = await fetch("./downloads.json", {
      cache: "no-store", signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error("Download information unavailable");
    const release = await response.json();
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(release.version)) throw new Error("Invalid version");
    const date = new Date(release.publishedAt);
    if (!Number.isFinite(date.getTime())) throw new Error("Invalid release date");
    // Validate the entire manifest before enabling any download link.
    const files = links.map((link) => {
      const file = release.files?.[link.dataset.file];
      if (!file || !/^[A-Za-z0-9_.-]+$/.test(file.name)
        || !file.name.includes(release.version)
        || !Number.isFinite(file.size) || file.size <= 0
        || !/\.(dmg|exe|AppImage|deb|rpm)$/.test(file.name)) {
        throw new Error("Invalid installer");
      }
      return file;
    });
    document.querySelector("#version").textContent = release.version;
    document.querySelector("#release-date").textContent = `发布于 ${new Intl.DateTimeFormat("zh-CN", {
      year: "numeric", month: "2-digit", day: "2-digit",
    }).format(date)}`;
    links.forEach((link, index) => {
      const file = files[index];
      link.href = OSS_BASE + encodeURIComponent(file.name);
      link.removeAttribute("aria-disabled");
      const meta = document.querySelector(`[data-meta="${link.dataset.file}"]`);
      if (meta) meta.textContent = `${metaLabels.get(meta)} · ${(file.size / 1024 / 1024).toFixed(0)} MB`;
      link.title = `${file.name} · ${(file.size / 1024 / 1024).toFixed(0)} MB`;
    });
    document.querySelector("#mac-note").textContent = release.macSigned
      ? "已签名并公证。下载后拖入「应用程序」文件夹。"
      : "当前版本尚未签名，首次打开请参阅下方安装说明。";
  } catch {
    document.querySelector("#release-date").textContent = "下载信息暂不可用";
    errorBox.hidden = false;
  }
}

const system = navigator.userAgentData?.platform || navigator.platform || "";
const platform = /mac/i.test(system) ? "mac" : /win/i.test(system) ? "windows" : /linux/i.test(system) ? "linux" : null;
if (platform && !/Android|iPhone|iPad/i.test(navigator.userAgent)) {
  document.querySelector(`[data-platform="${platform}"] .device-badge`).hidden = false;
}
document.querySelector("#retry").addEventListener("click", loadDownloads);
void loadDownloads();
