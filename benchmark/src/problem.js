/**
 * An error the client should see, in the same Problem Details format as the shop API,
 * so the website shows both the same way.
 */
class Problem extends Error {
  constructor(status, title, detail, extensions = {}) {
    super(detail ?? title);
    this.status = status;
    this.title = title;
    this.detail = detail;
    this.extensions = extensions;
  }

  toJSON() {
    return { title: this.title, status: this.status, detail: this.detail, ...this.extensions };
  }
}

module.exports = { Problem };
