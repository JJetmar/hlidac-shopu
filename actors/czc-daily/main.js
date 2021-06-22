const Apify = require("apify");
const { extractItems } = require("./src/itemParser");

const web = "https://www.czc.cz";
const { log } = Apify.utils;
Apify.main(async () => {
  // Get queue and enqueue first url.
  const { type, test } = await Apify.getValue("INPUT");
  const requestQueue = await Apify.openRequestQueue();

  if (type === "FULL") {
    await requestQueue.addRequest({
      url: "https://www.czc.cz/",
      userData: {
        label: "START"
      }
    });
    /* await requestQueue.addRequest({
            url: 'https://www.czc.cz/mesh/produkty',
            userData: {
                label: 'PAGE',
                baseUrl: 'https://www.czc.cz/mesh/produkty',
            },
        }); */
  } else if (type === "BF") {
    await requestQueue.addRequest({
      url: "https://www.czc.cz/black-friday/produkty",
      userData: {
        label: "BF"
      }
    });
  }

  // Create crawler.
  const crawler = new Apify.CheerioCrawler({
    requestQueue,
    useApifyProxy: true,
    apifyProxyGroups: ["CZECH_LUMINATI"],
    maxConcurrency: 10,
    // Activates the Session pool.
    useSessionPool: true,
    // Overrides default Session pool configuration.
    sessionPoolOptions: {
      maxPoolSize: 200
    },
    handlePageTimeoutSecs: 60,
    handlePageFunction: async ({ request, session, $, response }) => {
      if (response.statusCode !== 200 && response.statusCode !== 404) {
        log.info(`${request.url} -> Bad response code: ${response.statusCode}`);
        session.retire();
      }
      if (request.userData.label === "START") {
        const items = [];
        $(".main-menu__category a").each(function () {
          const categoryUrl = `${web}${$(this).attr("href")}`;
          // they got sometime some fuckups in the urls
          if (categoryUrl.indexOf("?/") !== -1) {
            items.push(categoryUrl.split("?/")[0]);
          } else {
            items.push(categoryUrl);
          }
        });
        console.log(`Found ${items.length} valid urls, going to enqueue them.`);
        for (const categoryUrl of items) {
          await requestQueue.addRequest({
            url: categoryUrl,
            userData: {
              label: "PAGE",
              baseUrl: categoryUrl
            }
          });
        }
      } else if (request.userData.label === "BF") {
        try {
          const items = await extractItems($, request, web);
          console.log(`Found ${items.length} storing them, ${request.url}`);
          await Apify.pushData(items);
        } catch (e) {
          console.log(e.message);
          console.log(`Failed extraction of items. ${request.url}`);
        }

        if ($("div.order-by-sum").length !== 0) {
          const max = parseInt(
            $("div.order-by-sum").text().replace(/\s+/g, "").match(/\d+/)[0]
          );
          const paginationCount = Math.ceil(max / 27) * 27;
          // https://www.czc.cz/black-friday-2019/produkty?q-first=99
          for (let i = 27; i < paginationCount; i += 27) {
            const paginationUrl = `https://www.czc.cz/black-friday/produkty?q-first=${i}`;
            await requestQueue.addRequest({
              url: paginationUrl,
              userData: {
                label: "PAGE"
              }
            });
          }
        }
      } else if (request.userData.label === "PAGE") {
        try {
          // we don't want to enqueu pagination on every page
          if (
            request.url.indexOf("q-first=") === -1 &&
            $("div.order-by-sum").length !== 0
          ) {
            const max = parseInt(
              $("div.order-by-sum").text().replace(/\s+/g, "").match(/\d+/)[0]
            );
            const paginationCount = Math.ceil(max / 27) * 27;

            console.log(
              `Adding the pagination to the queue for the ${request.url} for max ${paginationCount}`
            );
            for (let i = 27; i < paginationCount; i += 27) {
              const { baseUrl } = request.userData;
              let paginationUrl = null;
              if (baseUrl.indexOf("?") !== -1) {
                paginationUrl = `${baseUrl}&q-first=${i}`;
              } else {
                paginationUrl = `${baseUrl}/?q-first=${i}`;
              }
              await requestQueue.addRequest({
                url: paginationUrl,
                userData: {
                  label: "PAGE"
                }
              });
            }
          }
        } catch (e) {
          log.info(`Error on page ${request.url}`);
          log.error(e);
        }

        // there are some kategorie urls with the rosters
        try {
          if (request.url.endsWith("kategorie")) {
            const subCategoryUrls = [];
            $("a.scard-anim").each(function () {
              const subCategoryUrl =
                $(this).attr("href").indexOf("https") !== -1
                  ? $(this).attr("href")
                  : `${web}${$(this).attr("href")}`;
              console.log(subCategoryUrl);
              subCategoryUrls.push({
                url: subCategoryUrl,
                userData: {
                  label: "PAGE",
                  baseUrl: subCategoryUrl
                }
              });
            });
            for (const item of subCategoryUrls) {
              await requestQueue.addRequest(item);
            }
          }
        } catch (e) {
          log.info(e.message);
        }

        try {
          const items = await extractItems($, request, web);
          log.debug(`Found ${items.length} storing them, ${request.url}`);
          await Apify.pushData(items);
        } catch (e) {
          log.error(e);
          log.info(`Failed extraction of items. ${request.url}`);
        }
      }
    },

    // If request failed 4 times then this function is executed.
    handleFailedRequestFunction: async ({ request }) => {
      console.log(`Request ${request.url} failed 10 times`);
    }
  });
  // Run crawler.
  await crawler.run();

  console.log("crawler finished, calling upload.");
  if (!test) {
    // calling the keboola upload
    try {
      const env = await Apify.getEnv();
      const run = await Apify.call(
        "blackfriday/uploader",
        {
          datasetId: env.defaultDatasetId,
          upload: true,
          actRunId: env.actorRunId,
          blackFriday: type !== "FULL",
          tableName: type !== "FULL" ? "czc_bf" : "czc"
        },
        {
          waitSecs: 25
        }
      );
      console.log(`Keboola upload called: ${run.id}`);
    } catch (e) {
      console.log(e);
    }

    // stats page
    try {
      const env = await Apify.getEnv();
      const run = await Apify.callTask(
        "blackfriday/status-page-store",
        {
          datasetId: env.defaultDatasetId,
          name: type !== "FULL" ? "czc-black-friday" : "Czc-cz-complete-eshop"
        },
        {
          waitSecs: 25
        }
      );
      console.log(`Status page called: ${run.id}`);
    } catch (e) {
      console.log(e);
    }
  }

  console.log("Finished.");
});
