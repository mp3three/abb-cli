import { CacheService, FetchService, InjectConfig, QuickScript } from "@steggy/boilerplate";
import {
  ansiEscapes,
  ansiStrip,
  ApplicationManagerService,
  EnvironmentService,
  ErrorService,
  MainMenuEntry,
  PromptService,
  ScreenService,
  SyncLoggerService,
  TextRenderingService,
  TTYModule,
} from "@steggy/tty";
import {
  ARRAY_OFFSET,
  DOWN,
  HALF,
  INCREMENT,
  is,
  PEAT,
  SINGLE,
  START,
  TWO_THIRDS,
  UP,
  VALUE,
} from "@steggy/utilities";
import { eachLimit } from "async";
import chalk from "chalk";
import { load } from "cheerio";
import execa from "execa";

import { AudioBook, AudioBookRelated, BookListItem, Pagination } from "./types";

type MainMenuResult = string | { search: string };
const SEARCH_RESULTS = (text: string) => `SEARCH_RESULT:${is.hash(text)}`;
const BOOK_CACHE = (text: string) => `BOOK_CACHE:${is.hash(text)}`;
const RECENT_SEARCHES = "RECENT_SEARCHES";
/**
 * non-breaking space
 */
const NBSP = 160;
const CACHE_CLEAR_PACE = 50;

@QuickScript({
  application: Symbol("abb-cli"),
  imports: [TTYModule],
})
export class ABBCli {
  constructor(
    @InjectConfig("BASE", {
      default: "http://audiobookbay.fi",
      description: "Page target to pull information from",
      type: "string",
    })
    readonly base: string,
    @InjectConfig("LAUNCH", {
      description: "Target that can accept magnet links (ex: transmission-remote-gtk)",
      type: "string",
    })
    private readonly launch: string,
    @InjectConfig("LIMIT", {
      default: 5,
      description:
        "How many pages of search results to pull simultaniously. Be nice to their database",
      type: "number",
    })
    private readonly limit: number,
    @InjectConfig("RECENT", {
      default: 50,
      description: "How many recent searches to show",
      type: "number",
    })
    private readonly recent: number,
    private readonly application: ApplicationManagerService,
    private readonly cache: CacheService,
    private readonly environment: EnvironmentService,
    private readonly error: ErrorService,
    private readonly fetch: FetchService,
    private readonly logger: SyncLoggerService,
    private readonly prompt: PromptService,
    private readonly rendering: TextRenderingService,
    private readonly screen: ScreenService,
  ) {
    this.fetch.BASE_URL = base;
  }

  public async exec(): Promise<void> {
    this.application.setHeader("ABB CLI");
    const recent = await this.cache.get<string[]>(RECENT_SEARCHES, []);

    const action = await this.prompt.menu<MainMenuResult>({
      hideSearch: true,
      condensed: true,
      keyMap: {
        escape: ["done"],
        c: {
          entry: ["clear cache", "clear-cache"],
          highlight: "auto",
        },
        s: {
          entry: ["search"],
          highlight: "auto",
        },
      },
      left: is
        .unique(recent)
        .reverse()
        .filter(index => !is.empty(index))
        .slice(START, this.recent)
        .map(search => ({ entry: [search, { search }] })),
      leftHeader: "Recent Searches",
      right: [
        {
          entry: ["search"],
          helpText: "Execute a new search",
        },
        { entry: ["clear cache", "clear-cache"] },
      ],
      rightHeader: "Actions",
      showHeaders: true,
      restore: {
        id: "main_menu",
        type: "value",
      },
    });
    switch (action) {
      case "done":
        return;
      case "search":
        await this.search();
        return await this.exec();
      case "clear-cache":
        await this.clearCache();
        return await this.exec();
    }
    if (is.string(action)) {
      await this.error.menuError();
      return;
    }
    if ("search" in action) {
      await this.search(action.search);
    } else {
      await this.error.menuError();
      return;
    }
    await this.exec();
  }

  public async search(text?: string, lastValue?: string): Promise<void> {
    this.application.setHeader(`Audiobook Search`);
    // * Prompt for search text
    text ??= (await this.prompt.string({ label: "Search text" })).toLocaleLowerCase();
    if (is.empty(text)) {
      return;
    }

    // * Append search to list of recent search
    const recent = await this.cache.get<string[]>(RECENT_SEARCHES, []);
    await this.cache.set(RECENT_SEARCHES, [...recent, text]);

    // * Check to see if result is cached
    const resultKey = SEARCH_RESULTS(text);
    const cached = await this.cache.get<BookListItem[]>(resultKey);

    // * execute search + cache
    const books = cached ?? (await this.runSearch(text));
    await this.cache.set(resultKey, books);

    // ? Clear off logs
    this.application.reprintHeader();

    // ? Max length of labels is 2/3 of terminal width
    // Some titles can have a list of authors or narrators attached, and be unnecessarily long
    // Fortunately, the most useful information is at the start
    // Approximate observed format
    // > "title [- series info] [- narrator, narrator, narrator, author, etc]"
    //
    // There doesn't seem to be consistency in formatting of the titles, so magic parsing is a no go
    //
    const { width } = await this.environment.getDimensions();
    const maxWidth = Math.floor(width * TWO_THIRDS);
    const right = books.map(book => this.formatSearchEntry(book, maxWidth));
    const item = await this.prompt.menu<BookListItem>({
      headerMessage: [
        chalk`{blue.bold ?} {bold Search text}  {blueBright ${text}}`,
        chalk`{blue.bold ?} {bold Result count} {yellow ${books.length}}`,
      ].join(`\n`),
      keyMap: Object.fromEntries([
        ["escape", ["done"]],
        ...(is.empty(this.launch) ? [] : [["m", ["???? Exec", "quick-magnet"]]]),
      ]),
      keyMapCallback: async (action, [, value]: [string, BookListItem]) => {
        if (action !== "quick-magnet") {
          return true;
        }
        const book = await this.getBook(value.url);
        await execa(this.launch, [this.createMagnet(book)]);
        return chalk`{blue.dim ? } Launched magnet for {cyan ${book.title}}`;
      },
      right,
      value: right.find(index => index.entry[VALUE].url === lastValue)?.entry[VALUE],
    });
    if (is.string(item) || is.undefined(item)) {
      return;
    }
    await this.lookup(item.url);
    return await this.search(text, item.url);
  }

  protected async getBook(book: string): Promise<AudioBook> {
    const cache = await this.cache.get<AudioBook>(BOOK_CACHE(book));
    if (cache) {
      return cache;
    }
    const html = await this.fetch.fetch<string>({
      process: "text",
      url: `/audio-books/${encodeURI(book)}/`,
    });
    const out = this.buildBook(load(html));
    await this.cache.set(BOOK_CACHE(book), out);
    return out;
  }

  protected async lookup(id: string, book?: AudioBook): Promise<void> {
    if (!book) {
      this.application.setHeader("Lookup");
      book = await this.getBook(id);
    }
    this.application.setHeader("Lookup");
    const headerMessage = [
      chalk`{blue.bold URL} ${ansiEscapes.link(id, `${this.base}/audio-books/${encodeURI(id)}/`)}`,
      " ",
      this.rendering.type(
        Object.fromEntries(
          Object.entries(book)
            .sort(([a], [b]) => (a > b ? UP : DOWN))
            .filter(
              ([key, value]) =>
                !(is.string(value) && is.empty(value)) &&
                !["specs", "related", "torrent", "trackers", "description"].includes(key),
            ),
        ),
      ),
      " ",
    ].join(`\n`);
    const action = await this.prompt.menu({
      headerMessage,
      keyMap: Object.fromEntries([
        ["escape", ["done"]],
        ...(is.empty(this.launch) ? [] : [["m", ["???? Exec", "exec-magnet"]]]),
      ]),
      right: [
        { entry: ["See Description", "description"] },
        { entry: ["Create Magnet", "magnet"] },
      ],
      condensed: true,
      hideSearch: true,
      restore: {
        id: `lookup_${id}`,
        type: "value",
      },
    });
    switch (action) {
      case "magnet":
        this.screen.printLine(`???? ${this.createMagnet(book)}`);
        await this.prompt.acknowledge();
      // fall through
      case "done":
        return;
      case "exec-magnet":
        this.logger.info(`Launching magnet link with [${this.launch}]`);
        await execa(this.launch, [this.createMagnet(book)]);
        break;
      case "description":
        const { width } = await this.environment.getDimensions();
        const maxWidth = Math.floor(width * TWO_THIRDS);
        this.screen.printLine(
          book.description
            .split(`\n`)
            .map(line =>
              (line.match(new RegExp(`.{1,${maxWidth}}`, "g")) || [])
                .map(index => `  ${index}`)
                .join(`\n`),
            )
            .join(`\n\n`),
        );
        await this.prompt.acknowledge();
        break;
      default:
        await this.error.menuError();
        return;
    }
    await this.lookup(id, book);
  }

  protected async runSearch(query: string): Promise<BookListItem[]> {
    const html = await this.fetch.fetch<string>({
      params: { s: query.toLocaleLowerCase() },
      process: "text",
      url: `/page/1/`,
    });
    const [list, pagination] = await this.buildSearch(load(html));
    if (!pagination) {
      return [];
    }
    await eachLimit(PEAT(pagination.totalPages), this.limit, async page => {
      if (page === ARRAY_OFFSET) {
        this.logger.info(`Retrieved page {1}/[${pagination.totalPages}] ([${list.length}] items)`);
        return;
      }
      const html = await this.fetch.fetch<string>({
        params: { s: query.toLocaleLowerCase() },
        process: "text",
        url: `/page/${page}/`,
      });
      const [append] = await this.buildSearch(load(html));
      list.push(...append);
      this.logger.info(
        `Retrieved page {${page}}/[${pagination.totalPages}] ([${list.length}] items)`,
      );
    });
    return list;
  }

  private buildBook($: ReturnType<typeof load>): AudioBook {
    // * Categories
    const category = [];
    $(".postInfo a")
      .map((_, element) => {
        if ($(element).attr("rel") === "category tag") {
          category.push($(element).text());
        }
      })
      .filter(index => !is.undefined(index));

    // * Trackers
    const trackers: string[] = [];
    let hash: string;
    $(".postContent table tr").each((_, element) => {
      const trackerChild = $(element).find("td:first-child");
      const hashChild = $(element).find("td:last-child");
      switch (trackerChild.text()) {
        case "Tracker:":
          trackers.push(hashChild.text());
          break;
        case "Info Hash:":
          hash = hashChild.text();
          break;
        default:
          break;
      }
    });

    // * Related
    const related: AudioBookRelated[] = [];
    $(`#rsidebar ul li`).each((index, element) => {
      if ($(element).find("h2").text().includes("Related")) {
        $(element)
          .find("ul li")
          .each((_, relatedElement) => {
            const link = $(relatedElement).find("a");
            const url = link.attr("href");
            if (url) {
              related.push({
                title: link.text(),
                url: url.replace("/audio-books/", "").replace("/", ""),
              });
            }
          });
      }
    });

    // * Description => final object
    const desc = $(".desc");

    // ? When there is an audio sample, descriptions are formatted different
    const internal = desc.find("p:not(:first-child)").text();
    const parts = [];
    $(is.empty(internal) ? ".postContent p:not(:first-child)" : ".desc p:not(:first-child)").each(
      (index, node) => {
        $(node).find("br").replaceWith("\n");
        parts.push($(node).text());
      },
    );
    const description = parts.join(`\n`).trim();

    return {
      abridged: desc.find('span[class="is_abridged"]').text(),
      author: desc.find('span[class="author"]').text(),
      category,
      description,
      language: $('.postInfo a span[itemprop="inLanguage"]').text(),
      narrator: desc.find('span[class="narrator"]').text(),
      related,
      specs: {
        bitrate: desc.find('span[class="bitrate"]').text(),
        format: desc.find('span[class="format"]').text(),
      },
      title: $(".postTitle h1").text(),
      torrent: {
        hash,
        size: $(".postContent table tr:nth-last-child(11) td:last-child").text(),
        trackers,
      },
    };
  }

  // eslint-disable-next-line radar/cognitive-complexity
  private buildSearch($: ReturnType<typeof load>): [BookListItem[], Pagination] {
    if ($(`#content h3`).text().trim() === "Not Found") {
      return [undefined, undefined];
    }
    const out: BookListItem[] = [];
    $(`#content div.post`).map((_, element) => {
      const title = $(element).find(`div.postTitle h2 a`);
      const titleText = title.text();
      if (is.empty(titleText)) {
        return;
      }
      const url = title.attr("href");
      const cover = $(element).find(`.postContent img`).attr("src");

      const size = $(element).find(`.postContent span[style="color:#00f;"]`).text();

      out.push({
        category: $(element)
          .find(`.postInfo`)
          .text()
          .split("Language:")[0]
          .replace("Category:", "")
          .trim()
          .split(String.fromCodePoint(NBSP))
          .map((text: string) => text.trim()),
        cover: cover === "/images/default_cover.jpg" ? "http://audiobookbay.se" + cover : cover,
        info: {
          format: $(element).find(`.postContent span[style="color:#a00;"]:nth-child(2)`).text(),
          size,
          sizeUnit: is.empty(size)
            ? undefined
            : $(element).find(`p[style="text-align:center;"]`).text().split(size)[1].trim(),
          unit: $(element).find(`.postContent span[style="color:#a00;"]:nth-child(3)`).text(),
        },
        keywords: $(element)
          .find(".postInfo span")
          .text()
          .replace("Keywords:", "")
          .trim()
          .split(String.fromCodePoint(NBSP))
          .map((text: string) => text.trim()),
        lang: $(element).find(`.postInfo`).text().split("Language: ")[1].split(`Keywords:`)[0],
        posted: $(`p[style="text-align:center;"]`)
          .text()
          .split("Posted:")[1]
          .split("Format:")[0]
          .trim(),
        title: titleText,
        url: url ? url.replace("/audio-books/", "").replace("/", "") : undefined,
      });
      return size;
    });

    // * Pagination
    const pagination: Pagination = {
      count: out.length,
      currentPage: 0,
      totalPages: 0,
    };
    if (!is.empty($(`.navigation .current`).text())) {
      pagination.currentPage = Number.parseInt($(`.navigation .current`).text());
      if ($(`.navigation .wp-pagenavi a:last-child`).text() === "????") {
        const totalElement = $(`.navigation .wp-pagenavi a:last-child`).attr("href");
        if (totalElement) {
          pagination.totalPages = Number.parseInt(totalElement.split("/page/")[1].split("/")[0]);
        }
      } else {
        pagination.totalPages = Number.parseInt(
          $(`.navigation .wp-pagenavi a:nth-last-child(2)`).text(),
        );
      }

      if (pagination.totalPages + INCREMENT === pagination.currentPage) {
        pagination.totalPages = pagination.currentPage;
      }
    }
    return [out, pagination];
  }

  /**
   * Explicitly delete keys used by this app.
   * Don't fully truncate cache in case it's shared
   */
  private async clearCache(): Promise<void> {
    const keys = [
      ...(await this.cache.keys("SEARCH_RESULT*")),
      ...(await this.cache.keys("BOOK_CACHE*")),
    ];
    await this.cache.del("LAST_SEARCH");
    await this.cache.del("RECENT_SEARCHES");
    await eachLimit(keys, CACHE_CLEAR_PACE, async (key: string) => await this.cache.del(key));
  }

  private createMagnet({ title, torrent: { hash, trackers } }: AudioBook): string {
    return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(title)}&tr=${trackers
      .map(index => encodeURIComponent(index))
      .join("&tr=")}`;
  }

  private formatSearchEntry(item: BookListItem, maxWidth: number): MainMenuEntry<BookListItem> {
    // * Calculate padding for keywords header
    let length = "Keywords".length + INCREMENT;
    const keywordsPrefix = Math.floor(
      Math.max(START, Math.max(...item.keywords.map(index => index.length + SINGLE)) - length) *
        HALF,
    );
    const keywordsLength = keywordsPrefix + length;

    // * Calculate padding for categories header
    length = "Categories".length + INCREMENT;
    const categoriesPrefix = Math.floor(
      Math.max(START, Math.max(...item.category.map(index => index.length + SINGLE)) - length) *
        HALF,
    );
    const categoriesLength = categoriesPrefix + length;

    // * Limit the title length + ellipsize
    let title = ansiStrip(item.title);
    title = title.length > maxWidth ? `${title.slice(START, maxWidth)}...` : title;

    return {
      entry: [title, item],
      helpText: [
        chalk`{blue Detail}`,
        chalk`{bold Posted on:} ${item.posted}`,
        chalk`{bold Size:} ${item.info.size} ${item.info.sizeUnit}`,
        "",
        ...this.rendering.assemble(
          [
            chalk.bold(`Categories`.padStart(categoriesLength, " ")),
            ...item.category.map(index => chalk.blue(` ${index}`)),
          ],
          [
            chalk.bold("Keywords".padStart(keywordsLength, " ")),
            ...item.keywords.map(index => chalk.yellow(` ${index}`)),
          ],
        ),
      ]
        .filter(index => !is.undefined(index))
        .join(`\n`),
    };
  }
}
