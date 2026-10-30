import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  beginKnowledgeBaseSourceTurn,
  finishKnowledgeBaseSourceTurn,
  recordKnowledgeBaseSourceResult,
} from "../src/infrastructure/knowledgebase/knowledgeBaseSources.js";

describe("knowledge base response sources", () => {
  it("excludes folder links from directory listings while preserving document links", () => {
    beginKnowledgeBaseSourceTurn("directory-source-session");
    recordKnowledgeBaseSourceResult("directory-source-session", {
      ok: true,
      operationId: "listKnowledgeBasePages",
      data: {
        data: [
          {
            id: "folder-1",
            title: "01 公司全景",
            kind: "folder",
            sourceUrl: "https://oa-kb.example.test/wiki/folder-1",
          },
          {
            id: "page-1",
            title: "00 公司全景",
            kind: "page",
            sourceUrl: "https://oa-kb.example.test/wiki/page-1",
          },
        ],
      },
    });

    assert.deepEqual(finishKnowledgeBaseSourceTurn("directory-source-session"), [
      {
        title: "00 公司全景",
        description: "打开知识库查看完整内容。",
        originalContent: "打开知识库查看完整内容。",
        sourceUrl: "https://oa-kb.example.test/wiki/page-1",
      },
    ]);
  });

  it("does not cite a folder even when a page lookup returns content for it", () => {
    beginKnowledgeBaseSourceTurn("folder-lookup-session");
    recordKnowledgeBaseSourceResult("folder-lookup-session", {
      ok: true,
      operationId: "getKnowledgeBasePage",
      data: {
        data: {
          title: "01 公司全景",
          kind: "folder",
          content: "目录说明。",
          sourceUrl: "https://oa-kb.example.test/wiki/folder-1",
        },
      },
    });

    assert.deepEqual(finishKnowledgeBaseSourceTurn("folder-lookup-session"), []);
  });

  it("keeps document sources nested inside a folder response", () => {
    beginKnowledgeBaseSourceTurn("nested-directory-session");
    recordKnowledgeBaseSourceResult("nested-directory-session", {
      ok: true,
      data: {
        title: "01 公司全景",
        kind: "folder",
        sourceUrl: "https://oa-kb.example.test/wiki/folder-1",
        children: [
          {
            title: "00 公司全景",
            kind: "page",
            excerpt: "公司介绍正文。",
            sourceUrl: "https://oa-kb.example.test/wiki/page-1",
          },
        ],
      },
    });

    assert.deepEqual(finishKnowledgeBaseSourceTurn("nested-directory-session"), [
      {
        title: "00 公司全景",
        description: "公司介绍正文。",
        originalContent: "公司介绍正文。",
        sourceUrl: "https://oa-kb.example.test/wiki/page-1",
      },
    ]);
  });

  it("deduplicates sources and prefers page content over a search excerpt", () => {
    beginKnowledgeBaseSourceTurn("source-session");
    recordKnowledgeBaseSourceResult("source-session", {
      ok: true,
      data: {
        data: [
          {
            title: "生产部署手册",
            excerpt: "较短的搜索摘要。",
            sourceUrl: "https://oa-kb.example.test/wiki/page-1",
          },
        ],
      },
    });
    recordKnowledgeBaseSourceResult("source-session", {
      ok: true,
      data: {
        data: {
          title: "生产部署手册",
          content: "# 生产部署手册\n\n发布前请完成数据库迁移和镜像检查。",
          sourceUrl: "https://oa-kb.example.test/wiki/page-1",
        },
      },
    });

    assert.deepEqual(finishKnowledgeBaseSourceTurn("source-session"), [
      {
        title: "生产部署手册",
        description: "发布前请完成数据库迁移和镜像检查。",
        originalContent: "发布前请完成数据库迁移和镜像检查。",
        sourceUrl: "https://oa-kb.example.test/wiki/page-1",
      },
    ]);
  });

  it("ignores unsafe URLs and bounds long descriptions", () => {
    beginKnowledgeBaseSourceTurn("bounded-source-session");
    recordKnowledgeBaseSourceResult("bounded-source-session", {
      ok: true,
      data: {
        data: [
          {
            title: "不安全来源",
            excerpt: "不应显示",
            sourceUrl: "javascript:alert(1)",
          },
          {
            title: "超长制度",
            excerpt: "制度内容。".repeat(80),
            sourceUrl: "https://oa-kb.example.test/wiki/page-2",
          },
        ],
      },
    });

    const sources = finishKnowledgeBaseSourceTurn("bounded-source-session");
    assert.equal(sources.length, 1);
    assert.equal(sources[0]?.title, "超长制度");
    assert.ok((sources[0]?.description.length ?? 0) <= 180);
    assert.match(sources[0]?.description ?? "", /…$/);
    assert.equal(sources[0]?.originalContent, "制度内容。".repeat(80));
  });

  it("keeps the longest original content for duplicate excerpts", () => {
    beginKnowledgeBaseSourceTurn("duplicate-source-session");
    recordKnowledgeBaseSourceResult("duplicate-source-session", {
      ok: true,
      data: {
        data: [
          {
            title: "员工手册",
            excerpt: "简短摘要。",
            sourceUrl: "https://oa-kb.example.test/wiki/page-3",
          },
          {
            title: "员工手册",
            excerpt: "更完整的员工手册原文摘要。",
            sourceUrl: "https://oa-kb.example.test/wiki/page-3",
          },
        ],
      },
    });

    assert.equal(
      finishKnowledgeBaseSourceTurn("duplicate-source-session")[0]
        ?.originalContent,
      "更完整的员工手册原文摘要。",
    );
  });
});
