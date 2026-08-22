import { platform } from "node:os";

import {
  type Browser,
  type BrowserContext,
  chromium,
  type LaunchOptions,
  type Page,
} from "playwright-core";

import type { LocalOcrPort } from "../contracts/ocr";
import type {
  ScreenMaskRegion,
  ScreenTextRegion,
  SecureBrowserInspection,
  SecureBrowserPort,
  SecureBrowserTarget,
} from "../contracts/secure-computer";

interface PlaywrightSecureBrowserOptions {
  readonly ocr: LocalOcrPort;
  readonly allowedHosts: readonly string[];
  readonly executablePath?: string;
  readonly headless?: boolean;
  readonly viewport?: Readonly<{ width: number; height: number }>;
}

const candidateKey = (candidate: ScreenTextRegion): string =>
  `${candidate.text}\0${candidate.boundingBox.x}:${candidate.boundingBox.y}:${candidate.boundingBox.width}:${candidate.boundingBox.height}`;

const waitForRenderedBody = async (page: Page): Promise<void> => {
  await page.evaluate(
    (timeoutMs) =>
      new Promise<void>((resolve, reject) => {
        const hasRenderedContent = (): boolean => {
          const body = document.body;
          if (body === null) return false;
          if (body.innerText.trim().length > 0) return true;
          return (
            body.querySelector("a, button, canvas, iframe, input, select, svg, textarea") !== null
          );
        };
        if (hasRenderedContent()) {
          resolve();
          return;
        }
        const observer = new MutationObserver(() => {
          if (!hasRenderedContent()) return;
          observer.disconnect();
          clearTimeout(timeout);
          resolve();
        });
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          characterData: true,
        });
        const timeout = setTimeout(() => {
          observer.disconnect();
          reject(new Error(`Page did not render observable content within ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    30_000,
  );
};

export class PlaywrightSecureBrowser implements SecureBrowserPort {
  readonly #ocr: LocalOcrPort;
  readonly #allowedHosts: ReadonlySet<string>;
  readonly #launchOptions: LaunchOptions;
  readonly #viewport: Readonly<{ width: number; height: number }>;
  #browser: Browser | undefined;
  #context: BrowserContext | undefined;
  #page: Page | undefined;
  #closed = false;

  constructor(options: PlaywrightSecureBrowserOptions) {
    this.#ocr = options.ocr;
    this.#allowedHosts = new Set(options.allowedHosts.map((host) => host.toLowerCase()));
    this.#viewport = options.viewport ?? { width: 1440, height: 900 };
    this.#launchOptions = { headless: options.headless ?? false };
    if (options.executablePath !== undefined)
      this.#launchOptions.executablePath = options.executablePath;
    else if (platform() === "win32") this.#launchOptions.channel = "msedge";
  }

  async start(url: string): Promise<void> {
    if (this.#browser !== undefined || this.#closed)
      throw new Error("Secure browser is unavailable");
    this.#browser = await chromium.launch(this.#launchOptions);
    this.#context = await this.#browser.newContext({
      acceptDownloads: false,
      viewport: this.#viewport,
    });
    await this.#context.route("**/*", async (route) => {
      const requestUrl = new URL(route.request().url());
      if (
        ["data:", "blob:"].includes(requestUrl.protocol) ||
        this.#allowedHosts.has(requestUrl.hostname.toLowerCase())
      ) {
        await route.continue();
        return;
      }
      await route.abort("blockedbyclient");
    });
    this.#page = await this.#context.newPage();
    await this.#page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await waitForRenderedBody(this.#page);
  }

  async inspect(): Promise<SecureBrowserInspection> {
    const page = this.#requirePage();
    const screenshot = await page.screenshot({ type: "png" });
    const [domCandidates, ocrCandidates] = await Promise.all([
      this.#readDomCandidates(page),
      this.#ocr.recognize(screenshot),
    ]);
    const candidates = this.#deduplicate([...domCandidates, ...ocrCandidates]);
    const viewport = page.viewportSize() ?? this.#viewport;
    return { url: page.url(), width: viewport.width, height: viewport.height, candidates };
  }

  async captureMasked(regions: readonly ScreenMaskRegion[]): Promise<Uint8Array> {
    const page = this.#requirePage();
    await page.evaluate((masks) => {
      document.querySelector("[data-haksul-redaction-layer]")?.remove();
      const layer = document.createElement("div");
      layer.dataset.haksulRedactionLayer = "true";
      Object.assign(layer.style, {
        position: "fixed",
        inset: "0",
        zIndex: "2147483647",
        pointerEvents: "none",
      });
      for (const mask of masks) {
        const box = document.createElement("div");
        box.textContent = mask.label;
        Object.assign(box.style, {
          position: "absolute",
          left: `${mask.boundingBox.x}px`,
          top: `${mask.boundingBox.y}px`,
          width: `${mask.boundingBox.width}px`,
          height: `${mask.boundingBox.height}px`,
          overflow: "hidden",
          background: "#172033",
          color: "#ffffff",
          font: "600 12px sans-serif",
          lineHeight: `${mask.boundingBox.height}px`,
          whiteSpace: "nowrap",
        });
        layer.append(box);
      }
      document.documentElement.append(layer);
    }, regions);
    try {
      return await page.screenshot({ type: "png" });
    } finally {
      await page.evaluate(() => document.querySelector("[data-haksul-redaction-layer]")?.remove());
    }
  }

  async targetAt(x: number, y: number): Promise<SecureBrowserTarget | undefined> {
    return this.#requirePage().evaluate(
      ({ x: targetX, y: targetY }) => {
        const element = document.elementFromPoint(targetX, targetY);
        if (!(element instanceof HTMLElement)) return undefined;
        const input = element instanceof HTMLInputElement ? element : undefined;
        const role = element.getAttribute("role");
        const ariaLabel = element.getAttribute("aria-label");
        return {
          text: (element.innerText || element.getAttribute("name") || "").slice(0, 500),
          tagName: element.tagName,
          ...(role === null ? {} : { role }),
          ...(ariaLabel === null ? {} : { ariaLabel }),
          ...(input === undefined ? {} : { inputType: input.type }),
        };
      },
      { x, y },
    );
  }

  async click(x: number, y: number): Promise<void> {
    const page = this.#requirePage();
    await page.mouse.click(x, y);
    await this.#nextPaint(page);
  }

  async typeText(x: number, y: number, text: string): Promise<void> {
    const page = this.#requirePage();
    await page.mouse.click(x, y);
    await page.keyboard.press(platform() === "darwin" ? "Meta+A" : "Control+A");
    await page.keyboard.insertText(text);
    await this.#nextPaint(page);
  }

  async scroll(deltaX: number, deltaY: number): Promise<void> {
    const page = this.#requirePage();
    await page.mouse.wheel(deltaX, deltaY);
    await this.#nextPaint(page);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#browser?.close();
    } finally {
      await this.#ocr.dispose();
      this.#page = undefined;
      this.#context = undefined;
      this.#browser = undefined;
    }
  }

  async #readDomCandidates(page: Page): Promise<readonly ScreenTextRegion[]> {
    return page.evaluate(() => {
      const regions: ScreenTextRegion[] = [];
      const add = (text: string, rect: DOMRect): void => {
        const normalized = text.trim();
        if (normalized.length === 0 || rect.width <= 0 || rect.height <= 0) return;
        regions.push({
          text: normalized.slice(0, 2_000),
          boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        });
      };
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (
        let node = walker.nextNode();
        node !== null && regions.length < 1_000;
        node = walker.nextNode()
      ) {
        if (node.textContent === null) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        add(node.textContent, range.getBoundingClientRect());
      }
      for (const element of document.querySelectorAll("input, textarea")) {
        const value =
          element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
            ? element.value
            : "";
        add(value, element.getBoundingClientRect());
      }
      return regions;
    });
  }

  #deduplicate(candidates: readonly ScreenTextRegion[]): readonly ScreenTextRegion[] {
    return [
      ...new Map(candidates.map((candidate) => [candidateKey(candidate), candidate])).values(),
    ];
  }

  async #nextPaint(page: Page): Promise<void> {
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
  }

  #requirePage(): Page {
    if (this.#page === undefined) throw new Error("Secure browser is not started");
    return this.#page;
  }
}
