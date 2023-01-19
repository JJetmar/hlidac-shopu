import { S3Client } from "@aws-sdk/client-s3";
import { CloudFrontClient } from "@aws-sdk/client-cloudfront";
import { uploadToKeboola } from "@hlidac-shopu/actors-common/keboola.js";
import {
  invalidateCDN,
  uploadToS3v2
} from "@hlidac-shopu/actors-common/product.js";
import rollbar from "@hlidac-shopu/actors-common/rollbar.js";
import { ActorType } from "@hlidac-shopu/actors-common/actor-type.js";
import { Actor, Dataset, KeyValueStore, log, LogLevel } from "apify";
import { PlaywrightCrawler } from "@crawlee/playwright";
import { URL, URLSearchParams } from "url";
import { withPersistedStats } from "@hlidac-shopu/actors-common/stats.js";
import { parseHTML } from "linkedom/cached";

const RootUrl = "https://www.tetadrogerie.cz";

function listingBfUrl(baseUrl, currentPage = 1, pageSize = 60) {
  const url = new URL(baseUrl);
  let params = new URLSearchParams(url.search);
  params.set("stranka", currentPage.toString());
  params.set("pocet", pageSize.toString());
  // change the search property of the main url
  url.search = params.toString();
  return url.toString();
}

function listingUrl(baseUrl, currentPage = 1, pageSize = 60) {
  return new URL(
    `${baseUrl}?${new URLSearchParams({
      stranka: currentPage.toString(),
      pocet: pageSize.toString(),
      razeni: "price"
    })}`,
    RootUrl
  ).href;
}

const categoryLinkSelectors = [
  "ul.j-cat-3>li>a",
  "ul.j-cat-2>li>a",
  "ul.j-shop-categories-menu>li>a"
];

function categoryRequests(document) {
  const requests = [];
  for (const selector of categoryLinkSelectors) {
    for (const category of Array.from(
      document.querySelectorAll(`.j-eshop-menu ${selector}`)
    )) {
      requests.push(category.href);
    }
  }
  return requests;
}

function parseItem(el, category) {
  const actionPrice = parseFloat(
    el
      .querySelectorAll(".sx-item-price-action")
      ?.at(-1)
      ?.innerText?.replace(/\s+/g, "")
  );
  const initialPrice = parseFloat(
    el.querySelector(".sx-item-price-initial")?.innerText?.replace(/\s+/g, "")
  );
  const originalPrice = actionPrice ? initialPrice / 100 : null;
  const currentPrice = actionPrice ? actionPrice / 100 : initialPrice / 100;
  console.assert(currentPrice, "missing price");
  const itemUrl = new URL(el.querySelector(".sx-item-title").href, RootUrl)
    .href;
  return {
    itemId: el.querySelector(".j-product").getAttribute("data-skuid"),
    itemName: el.querySelector(".sx-item-title").innerText,
    img: el.querySelector("img").getAttribute("src"),
    itemUrl,
    currentPrice,
    originalPrice: originalPrice > currentPrice ? originalPrice : null,
    discounted: originalPrice > currentPrice,
    inStock: true,
    category
  };
}

function parseItems(document) {
  let category = document
    .querySelectorAll(".CMSBreadCrumbsLink")
    .map(x => x.innerText);
  const currentCategory = document
    .querySelectorAll(".CMSBreadCrumbsCurrentItem")
    .map(x => x.innerText);
  category.push(currentCategory);
  const categories = category.join(" > ");
  return document
    .querySelectorAll(".j-products .j-item")
    .map(el => parseItem(el, categories));
}

async function saveProducts(s3, products, stats, processedIds) {
  const requests = [];
  for (const product of products) {
    if (!processedIds.has(product.itemId)) {
      processedIds.add(product.itemId);
      requests.push(
        Dataset.pushData(product),
        uploadToS3v2(s3, product, { priceCurrency: "CZK" })
      );
      stats.inc("items");
    } else {
      stats.inc("itemsDuplicity");
    }
  }
  await Promise.all(requests);
}

const itemsPerPage = 60;

// Because shop dont use offsets, last page include all items from previous pages. Dont need scrap them, skip to last.
function lastPageNumber(count) {
  return Math.ceil(count / itemsPerPage);
}

async function main() {
  rollbar.init();
  const processedIds = new Set();

  const s3 = new S3Client({ region: "eu-central-1", maxAttempts: 3 });
  const cloudfront = new CloudFrontClient({
    region: "eu-central-1",
    maxAttempts: 3
  });

  const input = (await KeyValueStore.getInput()) ?? {};
  const {
    development = process.env.TEST,
    debug = false,
    test = false,
    maxRequestRetries = 3,
    type = ActorType.Full,
    bfUrl = "https://www.tetadrogerie.cz/eshop/produkty?offerID=ESH210007"
  } = input;

  if (development || debug) {
    log.setLevel(LogLevel.DEBUG);
  }

  const stats = await withPersistedStats(x => x, {
    categories: 0,
    items: 0,
    itemsDuplicity: 0,
    totalItems: 0,
    failed: 0
  });

  const proxyConfiguration = await Actor.createProxyConfiguration({
    useApifyProxy: !development
  });

  const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxRequestsPerMinute: 600,
    maxRequestRetries,
    navigationTimeoutSecs: 120,
    launchContext: {
      launchOptions: {
        headless: true
      }
    },
    async requestHandler({ request, page }) {
      const { step, category, currentPage } = request.userData;
      log.info("Processing page", { url: request.url, step });
      await page.waitForSelector(".sx-item-price-group");
      const text = await page.content();
      const { document } = parseHTML(text);

      const itemsCount = parseInt(
        document
          .querySelector(".j-product-count-main")
          .innerText.match(/(\d+)/)[1],
        10
      );

      if (step === "START") {
        log.info("Pagination info", { allItemsCount: itemsCount });
        const requests = categoryRequests(document).map(category => ({
          url: listingUrl(category),
          userData: {
            category,
            currentPage: 1
          }
        }));
        stats.add("categories", requests.length);
        await crawler.requestQueue.addRequests(requests);
      } else if (step === "BF") {
        log.info("Pagination info", { itemsCount, currentPage });
        if (!currentPage) {
          const lastPage = lastPageNumber(itemsCount);
          if (lastPage) {
            const url = listingBfUrl(request.url, lastPage);
            log.info(`Add last pagination to queue: ${url}`);
            await crawler.requestQueue.addRequest({
              url: url,
              userData: {
                currentPage: page,
                category: "BF"
              }
            });
          }
        }
      } else {
        log.info("Pagination info", { category, itemsCount, currentPage });
        if (
          currentPage === 1 &&
          itemsCount > itemsPerPage &&
          category !== "BF"
        ) {
          const lastPage = lastPageNumber(itemsCount);
          if (lastPage) {
            const url = listingUrl(category, lastPage);
            log.info(`Add last pagination to queue: ${url}`);
            await crawler.requestQueue.addRequest(
              {
                url: url,
                userData: {
                  category,
                  currentPage: lastPage
                }
              },
              { forefront: true }
            );
          }
        }

        const parsedItems = parseItems(document);
        await saveProducts(s3, parsedItems, stats, processedIds);
        log.info(`Found ${parsedItems.length} items, ${request.url}`);
      }
    },
    async failedRequestHandler({ request }, error) {
      log.error(`Request ${request.url} failed multiple times`, error);
      stats.inc("failed");
    }
  });

  const startingRequests = [];
  if (development && test) {
    startingRequests.push({
      url: "https://www.tetadrogerie.cz/eshop/produkty/uklid/myti-nadobi/doplnky-do-mycky?pocet=40&razeni=price"
    });
  } else if (type === ActorType.BlackFriday) {
    startingRequests.push({
      url: `${bfUrl}&pocet=60&razeni=price`,
      userData: {
        step: "BF"
      }
    });
  } else {
    startingRequests.push({
      url: listingUrl("/eshop", 1, 20),
      userData: {
        step: "START"
      }
    });
  }
  await crawler.run(startingRequests);
  log.info("crawler finished");

  if (!development) {
    let tableName = "teta_cz";
    if (type === ActorType.BlackFriday) {
      tableName = `${tableName}_bf`;
    }
    await Promise.all([
      invalidateCDN(cloudfront, "EQYSHWUECAQC9", "tetadrogerie.cz"),
      uploadToKeboola(tableName)
    ]);
    log.info("invalidated Data CDN");
  }
  log.info("Finished.");
}

await Actor.main(main);
