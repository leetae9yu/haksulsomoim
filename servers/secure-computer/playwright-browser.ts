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

export const deduplicateScreenCandidates = (
  candidates: readonly ScreenTextRegion[],
): readonly ScreenTextRegion[] => {
  const unique: ScreenTextRegion[] = [];
  for (const candidate of candidates) {
    if (
      unique.some((existing) => {
        const authoritativeDomOverlap = existing.source === "dom" && candidate.source === "ocr";
        if (existing.text !== candidate.text && !authoritativeDomOverlap) return false;
        const left = existing.boundingBox;
        const right = candidate.boundingBox;
        const width = Math.max(
          0,
          Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x),
        );
        const height = Math.max(
          0,
          Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y),
        );
        const intersectionArea = width * height;
        const candidateArea = right.width * right.height;
        const smallerArea = Math.min(left.width * left.height, right.width * right.height);
        if (existing.text === candidate.text) {
          return smallerArea > 0 && intersectionArea / smallerArea >= 0.7;
        }
        return candidateArea > 0 && intersectionArea / candidateArea >= 0.8;
      })
    ) {
      continue;
    }
    unique.push(candidate);
  }
  return unique;
};

export const intersectMaskRegion = (
  region: ScreenMaskRegion,
  viewport: Readonly<{ width: number; height: number }>,
): ScreenMaskRegion | undefined => {
  const box = region.boundingBox;
  const left = Math.max(0, box.x);
  const top = Math.max(0, box.y);
  const right = Math.min(viewport.width, box.x + box.width);
  const bottom = Math.min(viewport.height, box.y + box.height);
  if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) {
    return undefined;
  }
  return {
    label: region.label,
    boundingBox: { x: left, y: top, width: right - left, height: bottom - top },
  };
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
    const candidates = deduplicateScreenCandidates([
      ...domCandidates,
      ...ocrCandidates.map((candidate) => ({ ...candidate, source: "ocr" as const })),
    ]);
    const viewport = page.viewportSize() ?? this.#viewport;
    return { url: page.url(), width: viewport.width, height: viewport.height, candidates };
  }

  async captureMasked(regions: readonly ScreenMaskRegion[]): Promise<Uint8Array> {
    const page = this.#requirePage();
    const viewport = page.viewportSize() ?? this.#viewport;
    const visibleRegions = regions.flatMap((region) => {
      const visible = intersectMaskRegion(region, viewport);
      return visible === undefined ? [] : [visible];
    });
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
    }, visibleRegions);
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
      const contextIds = new Map<Element, string>();
      const contextFor = (node: Node): string | undefined => {
        const element = node instanceof Element ? node : node.parentElement;
        const root = element?.closest("dl > div, fieldset, label, li, tr, [role='row']");
        if (root === null || root === undefined) return undefined;
        const existing = contextIds.get(root);
        if (existing !== undefined) return existing;
        const context = `dom-context-${contextIds.size + 1}`;
        contextIds.set(root, context);
        return context;
      };
      const add = (text: string, rect: DOMRect, context?: string): void => {
        const normalized = text.trim();
        if (normalized.length === 0 || rect.width <= 0 || rect.height <= 0) return;
        regions.push({
          text: normalized.slice(0, 2_000),
          boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          source: "dom",
          ...(context === undefined ? {} : { context }),
        });
      };
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (
        let node = walker.nextNode();
        node !== null && regions.length < 1_000;
        node = walker.nextNode()
      ) {
        if (node.textContent === null) continue;
        for (const match of node.textContent.matchAll(/\S+/gu)) {
          const start = match.index;
          const range = document.createRange();
          range.setStart(node, start);
          range.setEnd(node, start + match[0].length);
          add(match[0], range.getBoundingClientRect(), contextFor(node));
        }
      }
      for (const element of document.querySelectorAll("input, textarea")) {
        const value =
          element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
            ? element.value
            : "";
        add(value, element.getBoundingClientRect(), contextFor(element));
      }
      return regions;
    });
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
