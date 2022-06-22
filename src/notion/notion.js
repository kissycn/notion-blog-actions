const { Client } = require("@notionhq/client");
const { default: axios } = require("axios");
const AdmZip = require("adm-zip");
const YAML = require("yaml");

class notion {
  client;
  http;
  space_id;
  database_id;
  output;

  constructor({ token, token_v2, space_id, database_id, output }) {
    this.client = new Client({
      auth: token,
    });

    this.http = axios.create({
      headers: {
        cookie: `token_v2=${token_v2}`,
      },
    });

    this.space_id = space_id;
    this.database_id = database_id;
    this.output = output;
  }

  async run() {
    let pages = await this.pages();
    console.log(`获取到待发布文章: ${pages.length}篇`);
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      let title = page.properties.title.title[0].plain_text;

      console.log(`正在尝试下载第 ${i + 1} 篇文章: ${title}`);

      let id = await this.addTask(page.id);
      let url = await this.syncTask(id);

      await this.download(url, title);
      await this.updateProps(page);
    }
  }

  async pages() {
    let resp = await this.client.databases.query({
      database_id: this.database_id,
      filter: {
        property: "status",
        select: {
          equals: "待发布",
        },
      },
    });
    return resp.results;
  }

  async addTask(id) {
    let params = {
      task: {
        eventName: "exportBlock",
        request: {
          block: {
            id: id,
            spaceId: this.space_id,
          },
          recursive: false,
          exportOptions: {
            exportType: "markdown",
            timeZone: "Asia/Shanghai",
            locale: "en",
          },
        },
      },
    };
    let url = "https://www.notion.so/api/v3/enqueueTask";
    let resp = await this.http.post(url, params);
    return resp.data.taskId;
  }

  async syncTask(id) {
    for (let i = 1; i <= 20; i++) {
      console.log(`第 ${i} 次尝试获取导出任务 ${id} 数据`);
      let url = "https://www.notion.so/api/v3/getTasks";
      let resp = await this.http.post(url, { taskIds: [id] });
      let status = resp.data.results[0].status;
      if (
        resp.data &&
        resp.data.results &&
        resp.data.results.length == 1 &&
        resp.data.results[0].status &&
        status.type == "complete"
      ) {
        return status.exportURL;
      }
      await sleep(2000);
    }
  }

  async download(url, title) {
    // 下载压缩包
    let resp = await this.http.get(url, {
      responseType: "stream",
    });
    let buf = await streamToBuffer(resp.data);
    let zip = new AdmZip(buf);
    zip.getEntries().forEach((entry) => {
      if (!entry.entryName.includes(".md")) return;
      let page = this.frontMatter(entry.getData().toString(), title);
      entry.setData(page);
      entry.entryName = title + ".md";
    });
    zip.extractAllTo(this.output, true);
  }

  /**
   *
   * @param {string} page
   */
  frontMatter(page, title) {
    page = page.replace(`# ${title}`, "").trim();

    let keys = [
      "categories",
      "date",
      "excerpt",
      "status",
      "tags",
      "urlname",
      "category_bar",
      "index_img",
    ];
    let pattern = `(${keys.join("|")}):\\s(.*)\n`;
    let re = new RegExp(pattern, "igm");

    let data = {};
    let matchs = page.matchAll(re);
    for (const m of matchs) {
      let key = m[1];
      let val = m[2];
      if (key in data) {
        console.log(
          `${key} is exist in data, will skip, current: ${data[key]}, new: ${val}`
        );
        continue;
      }

      data[key] = val;
      if (key == "categories" || key == "tags") {
        data[key] = val.split(",").map((item) => item.trim());
      }
      page = page.replace(m[0], "");
    }

    data.title = title;
    let fm = YAML.stringify(data, { doubleQuotedAsJSON: true });
    page = `---\n${fm}---\n\n${page}`;
    return page;
  }

  /**
   * 修改状态为已发布
   * @param {*} page
   */
  async updateProps(page) {
    let props = page.properties;
    props.status.select = { name: "已发布" };
    await this.client.pages.update({
      page_id: page.id,
      properties: props,
    });
  }
}

async function sleep(ms) {
  // return await for better async stack trace support in case of errors.
  return await new Promise((resolve) => setTimeout(resolve, ms));
}
async function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const data = [];

    stream.on("data", (chunk) => {
      data.push(chunk);
    });

    stream.on("end", () => {
      resolve(Buffer.concat(data));
    });

    stream.on("error", (err) => {
      reject(err);
    });
  });
}
module.exports = notion;
