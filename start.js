const express = require("express");
const fs = require("fs");
const app = express();
const port = 3000;

const axios = require("axios");
const cheerio = require("cheerio");

const url = "https://www.wired.com";

const scrapeWiredArticles = async () => {
  try {
    console.log("Fetching homepage...");
    const response = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      },
      timeout: 15000, // timeout for homepage fetch
    });
    console.log("Homepage fetched successfully.");

    const $ = cheerio.load(response.data);
    const homepageArticles = []; // Array that store initial articles (title, link, date: null)

    // INITIAL SCRAPE: Extract JSON-LD structured data from homepage
    $('script[type="application/ld+json"]').each((i, el) => {
      try {
        const jsonLd = JSON.parse($(el).html());

        const addArticleToList = (schemaObject) => {
          // Check for 'headline' or 'name' (for Article types) and 'url'
          if (
            (schemaObject.headline || schemaObject.name) &&
            schemaObject.url
          ) {
            const cleanedUrl = schemaObject.url.replace(/\\u002F/g, "/");
            // Ensure unique links before adding
            const isDuplicate = homepageArticles.some(
              (existing) => existing.link === cleanedUrl
            );
            if (!isDuplicate) {
              homepageArticles.push({
                title: schemaObject.headline || schemaObject.name, // Use headline or name
                link: cleanedUrl,
                date: null, // Date will be fetched in the deep scrape
              });
            }
          }
        };

        const processJsonLdItem = (item) => {
          if (
            item["@type"] === "ItemList" &&
            Array.isArray(item.itemListElement)
          ) {
            item.itemListElement.forEach((articleItem) => {
              // Check if the item itself is an Article
              if (articleItem["@type"] === "Article") {
                addArticleToList(articleItem);
              }
              // Check if the actual article is nested under 'item' property
              else if (
                articleItem.item &&
                articleItem.item["@type"] === "Article"
              ) {
                addArticleToList(articleItem.item);
              }
              // Check if the item has a name and url (for non-Article types)
              else if (articleItem.name && articleItem.url) {
                const cleanedUrl = articleItem.url.replace(/\\u002F/g, "/");
                const isDuplicate = homepageArticles.some(
                  (existing) => existing.link === cleanedUrl
                );
                if (!isDuplicate) {
                  homepageArticles.push({
                    title: articleItem.name,
                    link: cleanedUrl,
                    date: null,
                  });
                }
              }
            });
          }
          // If the item is a single Article, add it directly
          else if (item["@type"] === "Article") {
            addArticleToList(item);
          }
        };

        if (Array.isArray(jsonLd)) {
          jsonLd.forEach(processJsonLdItem);
        } else {
          processJsonLdItem(jsonLd);
        }
      } catch (e) {
        console.error(
          `Error parsing or processing JSON-LD script ${i} on homepage:`,
          e.message
        );
      }
    });

    // ADDITIONAL SCRAPING METHODS: Extract articles from HTML elements
    $(".summary-item").each((i, el) => {
      const titleElement = $(el).find('[data-testid="SummaryItemHed"]');
      const title = titleElement.text().trim();

      const linkElement = $(el).find("a.summary-item__hed-link");
      let link = linkElement.attr("href");

      if (title && link) {
        if (link.startsWith("/")) {
          link = `https://www.wired.com${link}`;
        }
        const isDuplicate = homepageArticles.some(
          (article) => article.link === link
        );
        if (!isDuplicate) {
          homepageArticles.push({ title, link, date: null });
        }
      }
    });

    // ADDITIONAL SCRAPING METHODS: Extract articles from Subtopic Discovery containers
    $(
      '.SubtopicDiscoveryHedContainer-ehGPZM, div[class*="SubtopicDiscoveryHedContainer"]'
    ).each((i, el) => {
      const linkElement = $(el).find("a[href]");
      let link = linkElement.attr("href");
      const titleElement = linkElement.find("h2"); // Assuming 'h2' is the title within these containers
      const title = titleElement.text().trim();

      if (title && link) {
        if (link.startsWith("/")) {
          link = `https://www.wired.com${link}`;
        }
        const isDuplicate = homepageArticles.some(
          (article) => article.link === link
        );
        if (!isDuplicate) {
          homepageArticles.push({ title, link, date: null });
        }
      }
    });

    console.log(
      `Found ${homepageArticles.length} unique articles from homepage. Starting deep scrape for dates...`
    );

    // DEEP SCRAPE: Fetch dates for each article
    const finalArticles = [];
    for (const article of homepageArticles) {
      let articleDate = null;
      try {
        console.log(`Fetching date for: ${article.link}`);
        const articleResponse = await axios.get(article.link, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
          },
          timeout: 10000, // timeout for individual article requests
        });
        const article$ = cheerio.load(articleResponse.data);

        // 1. Check for JSON-LD structured data first
        article$('script[type="application/ld+json"]').each((i, el) => {
          if (articleDate) return false; // If date already found, stop iterating
          try {
            const jsonLdArticle = JSON.parse(article$(el).html());

            const findDateInSchema = (schema) => {
              if (
                schema &&
                schema["@type"] === "Article" &&
                (schema.datePublished || schema.dateModified)
              ) {
                return schema.datePublished || schema.dateModified;
              }
              return null;
            };

            if (Array.isArray(jsonLdArticle)) {
              for (const schema of jsonLdArticle) {
                articleDate = findDateInSchema(schema);
                if (articleDate) break; // Found date, stop iterating schemas
              }
            } else {
              articleDate = findDateInSchema(jsonLdArticle);
            }
          } catch (e) {
            // console.error(`Error parsing JSON-LD on article page ${article.link}:`, e.message);
          }
        });

        // 2. Check for Open Graph or Meta tags if date not found
        if (!articleDate) {
          const publishedMeta = article$(
            'meta[property="article:published_time"]'
          ).attr("content");
          if (publishedMeta) {
            articleDate = publishedMeta;
          } else {
            const dateMeta = article$('meta[name="date"]').attr("content");
            if (dateMeta) articleDate = dateMeta;
          }
        }

        // 3. Check for date in HTML elements if date not found
        if (!articleDate) {
          const timeElement = article$("time[datetime]");
          if (timeElement.length) {
            articleDate =
              timeElement.attr("datetime") || timeElement.text().trim();
          } else {
            // Look for common date patterns in text within specific elements
            const textDateElement = article$(
              'span.byline-date, .article-date, [data-component*="date"]'
            );
            if (textDateElement.length) {
              articleDate = textDateElement.text().trim();
            }
          }
        }

        finalArticles.push({
          title: article.title,
          link: article.link,
          date: articleDate || "N/A", // Assign the date found, or 'N/A' if still not found
        });
      } catch (error) {
        console.error(
          `Error fetching or parsing article ${article.link}:`,
          error.message
        );
        finalArticles.push({
          title: article.title,
          link: article.link,
          date: null, // Set to null or 'Invalid Date' if an error occurs to avoid breaking date parsing in HTML
        });
      }
      // Add a polite delay between requests
      await new Promise((resolve) => setTimeout(resolve, 500)); // Increased delay to 500ms
    }

    // Save the final extracted articles to a JSON file
    fs.writeFileSync(
      "wired_articles.json",
      JSON.stringify(finalArticles, null, 2),
      "utf-8"
    );
    console.log("Final articles (with dates) saved to wired_articles.json.");

    // Display all results in the console
    if (finalArticles.length > 0) {
      console.log("\nArticles found:", finalArticles.length, "\n");
    } else {
      console.log("\nNo articles found using the current scraping methods.");
      console.log(
        "This might be due to dynamic content loading (JavaScript rendering) or outdated HTML selectors."
      );
      console.log(
        "Please inspect 'wired.com' and the live wired.com page's source code to verify."
      );
    }
  } catch (error) {
    console.error("Error fetching the initial homepage:", error.message);
    if (error.response) {
      console.error(`Status: ${error.response.status}`);
      console.error(`Data: ${error.response.data}`);
    }
    // Ensure an empty file is created or handle the state gracefully if scraping fails entirely
    fs.writeFileSync(
      "wired_articles.json",
      JSON.stringify([], null, 2),
      "utf-8"
    );
    console.log(
      "No articles could be scraped. An empty wired_articles.json file has been created."
    );
  }
};

// Execute the scraping function once when the server starts
scrapeWiredArticles()
  .then(() => {
    // Serve html on /
    app.get("/", (req, res) => {
      res.sendFile(__dirname + "/wired-articles-list.html");
    });

    // Serve the articles.json data on /articles
    app.get("/articles", (req, res) => {
      fs.readFile("wired_articles.json", "utf8", (err, data) => {
        if (err) {
          console.error("Error reading JSON file:", err);
          if (err.code === "ENOENT") {
            res
              .status(404)
              .send("Articles data not found. Please run the scraper first.");
          } else {
            res.status(500).send("Server Error reading articles data.");
          }
          return;
        }
        res.setHeader("Content-Type", "application/json");
        res.send(data);
      });
    });

    // Start the server
    app.listen(port, () => {
      console.log(`Server running at http://localhost:${port}`);
    });
  })
  .catch((err) => {
    console.error("Failed to start server due to scraping error:", err);
  });
