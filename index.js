const TELEGRAM_API = "https://api.telegram.org";

/*
 * ==============================
 * 基础配置
 * ==============================
 */

const VERIFY_TTL = 10 * 60;        // 验证 Token：10 分钟
const IP_WINDOW = 10 * 60;         // IP 限流窗口：10 分钟
const IP_LIMIT = 10;               // 每个 IP 10 分钟最多 10 次

/*
 * 用户退出记录保存 30 天
 */
const LEFT_USER_TTL = 60 * 60 * 24 * 30;


/*
 * ==============================
 * Worker 入口
 * ==============================
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    /*
     * 自动设置 Telegram Webhook
     *
     * 浏览器访问：
     *
     * /setup
     */
    if (
      request.method === "GET" &&
      url.pathname === "/setup"
    ) {
      return setupTelegramWebhook(request, env);
    }


    /*
     * 获取重新申请入群链接
     *
     * /invite
     *
     * 需要 ?chat_id=-100xxxxxxxx
     */
    if (
      request.method === "GET" &&
      url.pathname === "/invite"
    ) {
      return createVerificationInvite(request, env);
    }


    /*
     * Telegram Webhook
     */
    if (
      request.method === "POST" &&
      url.pathname ===
        `/telegram/webhook/${env.WEBHOOK_SECRET}`
    ) {
      return handleTelegramWebhook(request, env);
    }


    /*
     * Turnstile 验证页面
     */
    if (
      request.method === "GET" &&
      url.pathname === "/verify"
    ) {
      return showVerifyPage(request, env);
    }


    /*
     * Turnstile 验证提交
     */
    if (
      request.method === "POST" &&
      url.pathname === "/verify"
    ) {
      return handleVerify(request, env);
    }


    return new Response(
      "Telegram Turnstile Verification Bot",
      {
        status: 200,
      }
    );
  },
};


/*
 * =========================================================
 * 设置 Telegram Webhook
 * =========================================================
 */

async function setupTelegramWebhook(
  request,
  env
) {
  const url = new URL(request.url);

  const webhookUrl =
    `${url.origin}/telegram/webhook/${env.WEBHOOK_SECRET}`;


  const result = await telegram(
    "setWebhook",
    {
      url: webhookUrl,

      /*
       * Telegram Secret Token
       */
      secret_token:
        env.WEBHOOK_SECRET,

      /*
       * 我们需要：

       * chat_join_request
       * chat_member
       */
      allowed_updates: [
        "chat_join_request",
        "chat_member",
      ],
    },
    env
  );


  return json({
    webhook: webhookUrl,

    telegram: result,
  });
}


/*
 * =========================================================
 * Telegram Webhook
 * =========================================================
 */

async function handleTelegramWebhook(
  request,
  env
) {
  /*
   * 检查 Telegram Secret Token
   */
  const telegramSecret =
    request.headers.get(
      "X-Telegram-Bot-Api-Secret-Token"
    );


  if (
    telegramSecret !==
    env.WEBHOOK_SECRET
  ) {
    return new Response(
      "Unauthorized",
      {
        status: 401,
      }
    );
  }


  let update;

  try {
    update = await request.json();
  } catch {
    return new Response(
      "Bad Request",
      {
        status: 400,
      }
    );
  }


  /*
   * =====================================================
   * 处理 chat_member
   * =====================================================
   */

  const memberUpdate =
    update.chat_member;


  if (memberUpdate) {
    await handleChatMemberUpdate(
      memberUpdate,
      env
    );

    return json({
      ok: true,
    });
  }


  /*
   * =====================================================
   * 处理 chat_join_request
   * =====================================================
   */

  const joinRequest =
    update.chat_join_request;


  if (!joinRequest) {
    return json({
      ok: true,
    });
  }


  await handleJoinRequest(
    joinRequest,
    request,
    env
  );


  return json({
    ok: true,
  });
}


/*
 * =========================================================
 * 处理成员状态变化
 * =========================================================
 */

async function handleChatMemberUpdate(
  memberUpdate,
  env
) {
  const chatId =
    memberUpdate.chat.id;

  const userId =
    memberUpdate.from.id;


  const oldStatus =
    memberUpdate.old_chat_member.status;

  const newStatus =
    memberUpdate.new_chat_member.status;


  /*
   * 用户主动退出
   *
   * member status：
   *
   * member
   * restricted
   * left
   * kicked
   */
  if (
    oldStatus !== "left" &&
    newStatus === "left"
  ) {
    await env.TELEGRAM_VERIFY.put(
      `left:${chatId}:${userId}`,

      JSON.stringify({
        chatId,
        userId,

        leftAt: Date.now(),

        /*
         * 再次申请必须验证
         */
        needsVerification: true,
      }),

      {
        expirationTtl:
          LEFT_USER_TTL,
      }
    );


    /*
     * 如果用户退出，
     * 给他发送一个重新申请提示
     */
    try {
      const invite =
        await createInviteLink(
          chatId,
          env
        );


      if (
        invite.ok &&
        invite.result?.invite_link
      ) {
        await telegram(
          "sendMessage",
          {
            chat_id: userId,

            text:
              "你已经退出群组。\n\n" +
              "如果你想重新加入，请使用下面的链接申请加入。\n\n" +
              "⚠️ 重新加入时需要再次完成 Cloudflare Turnstile 人机验证。",

            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text:
                      "🔐 重新申请入群",

                    url:
                      invite.result.invite_link,
                  },
                ],
              ],
            },
          },
          env
        );
      }
    } catch (error) {
      console.error(
        "Failed to send rejoin link:",
        error
      );
    }
  }
}


/*
 * =========================================================
 * 处理入群申请
 * =========================================================
 */

async function handleJoinRequest(
  joinRequest,
  request,
  env
) {
  const chatId =
    joinRequest.chat.id;

  const userId =
    joinRequest.from.id;


  /*
   * 生成随机 Token
   */
  const nonce =
    crypto.randomUUID();


  const now =
    Date.now();


  /*
   * 保存验证信息
   */
  const verifyData = {
    chatId,

    userId,

    createdAt:
      now,

    expiresAt:
      now +
      VERIFY_TTL * 1000,

    verified:
      false,
  };


  await env.TELEGRAM_VERIFY.put(
    `verify:${nonce}`,

    JSON.stringify(
      verifyData
    ),

    {
      expirationTtl:
        VERIFY_TTL,
    }
  );


  /*
   * 验证页面
   */
  const origin =
    new URL(request.url).origin;


  const verifyUrl =
    `${origin}/verify?token=${encodeURIComponent(nonce)}`;


  /*
   * 删除旧的退出记录
   *
   * 用户现在又申请了，
   * 表示重新进入验证流程。
   */
  await env.TELEGRAM_VERIFY.delete(
    `left:${chatId}:${userId}`
  );


  /*
   * 给用户发送验证消息
   */
  const text =
    `👋 欢迎申请加入「${joinRequest.chat.title || "本群"}」\n\n` +

    `为了防止机器人和垃圾账号，请先完成人机验证。\n\n` +

    `⏱ 验证链接有效期：10 分钟\n\n` +

    `完成验证后，你的入群申请会自动批准。`;


  const result =
    await telegram(
      "sendMessage",
      {
        chat_id:
          joinRequest.user_chat_id,

        text,

        reply_markup: {
          inline_keyboard: [
            [
              {
                text:
                  "🛡 开始验证",

                url:
                  verifyUrl,
              },
            ],
          ],
        },
      },
      env
    );


  if (!result.ok) {
    console.error(
      "sendMessage failed:",
      result
    );
  }
}


/*
 * =========================================================
 * 创建需要批准的邀请链接
 * =========================================================
 */

async function createInviteLink(
  chatId,
  env
) {
  return telegram(
    "createChatInviteLink",
    {
      chat_id:
        chatId,

      name:
        "Turnstile Verification",

      /*
       * 关键：
       *
       * 用户点击后不会直接加入，
       * 而是产生 chat_join_request
       */
      creates_join_request:
        true,
    },
    env
  );
}


/*
 * =========================================================
 * /invite
 *
 * 浏览器访问：
 *
 * /invite?chat_id=-100xxxxxxxx
 *
 * 创建一个需要验证的邀请链接
 * =========================================================
 */

async function createVerificationInvite(
  request,
  env
) {
  const url =
    new URL(request.url);


  const chatId =
    url.searchParams.get(
      "chat_id"
    );


  if (!chatId) {
    return json(
      {
        ok: false,

        error:
          "缺少 chat_id",
      },

      400
    );
  }


  const result =
    await createInviteLink(
      chatId,
      env
    );


  return json({
    ok:
      result.ok,

    invite_link:
      result.result?.invite_link ||
      null,

    telegram:
      result,
  });
}


/*
 * =========================================================
 * 显示 Turnstile 页面
 * =========================================================
 */

async function showVerifyPage(
  request,
  env
) {
  const url =
    new URL(request.url);


  const token =
    url.searchParams.get(
      "token"
    );


  if (!token) {
    return errorPage(
      "无效链接",

      "缺少验证 Token。"
    );
  }


  /*
   * IP 限流
   */
  const ip =
    getClientIP(request);


  const allowed =
    await checkIPRateLimit(
      ip,
      env
    );


  if (!allowed) {
    return errorPage(
      "请求过于频繁",

      "这个 IP 的验证请求次数过多，请稍后再试。"
    );
  }


  /*
   * KV
   */
  const record =
    await env.TELEGRAM_VERIFY.get(
      `verify:${token}`,

      "json"
    );


  if (!record) {
    return errorPage(
      "验证链接失效",

      "这个验证链接不存在、已经使用或者已经过期。"
    );
  }


  /*
   * 过期
   */
  if (
    record.expiresAt <
    Date.now()
  ) {
    await env.TELEGRAM_VERIFY.delete(
      `verify:${token}`
    );


    return errorPage(
      "验证链接过期",

      "请重新申请加入群组。"
    );
  }


  /*
   * 防重复
   */
  if (
    record.verified
  ) {
    return errorPage(
      "验证链接已经使用",

      "这个验证链接已经完成验证。"
    );
  }


  return htmlPage(
    "入群验证",

    `
      <h1>
        🛡 入群验证
      </h1>

      <p>
        请完成 Cloudflare Turnstile 人机验证。
      </p>

      <form
        method="POST"
        action="/verify"
      >

        <input
          type="hidden"
          name="token"
          value="${escapeHtml(token)}"
        />


        <div
          class="cf-turnstile"

          data-sitekey="${escapeHtml(
            env.TURNSTILE_SITE_KEY
          )}"

          data-callback="turnstileSuccess"

          data-error-callback="turnstileError"

          data-expired-callback="turnstileExpired"
        >
        </div>


        <div
          id="turnstile-status"
          class="status"
        >
        </div>


        <button
          type="submit"
        >
          验证并加入群组
        </button>

      </form>


      <script>

        function turnstileSuccess(token) {

          document
            .getElementById(
              "turnstile-status"
            )
            .innerText =
              "✅ Turnstile 验证成功";
        }


        function turnstileError(error) {

          document
            .getElementById(
              "turnstile-status"
            )
            .innerText =
              "❌ Turnstile 错误：" +
              error;
        }


        function turnstileExpired() {

          document
            .getElementById(
              "turnstile-status"
            )
            .innerText =
              "⚠️ Turnstile 已过期，请重新验证";
        }

      </script>


      <script
        src="https://challenges.cloudflare.com/turnstile/v0/api.js"
        async
        defer>
      </script>
    `
  );
}


/*
 * =========================================================
 * 处理 Turnstile
 * =========================================================
 */

async function handleVerify(
  request,
  env
) {
  /*
   * IP 限流
   */
  const ip =
    getClientIP(request);


  const allowed =
    await checkIPRateLimit(
      ip,
      env
    );


  if (!allowed) {
    return errorPage(
      "请求过于频繁",

      "请等待几分钟后再尝试。"
    );
  }


  /*
   * 表单
   */
  const form =
    await request.formData();


  const token =
    form.get("token");


  /*
   * 注意：
   *
   * Cloudflare Turnstile
   * 默认字段名称是：
   *
   * cf-turnstile-response
   */
  const turnstileToken =
    form.get(
      "cf-turnstile-response"
    );


  if (
    !token ||
    !turnstileToken
  ) {
    return errorPage(
      "验证失败",

      "请完成 Turnstile 验证。"
    );
  }


  /*
   * KV
   */
  const key =
    `verify:${token}`;


  const record =
    await env.TELEGRAM_VERIFY.get(
      key,

      "json"
    );


  if (!record) {
    return errorPage(
      "验证链接失效",

      "验证链接不存在、已经使用或者已经过期。"
    );
  }


  /*
   * 过期
   */
  if (
    record.expiresAt <
    Date.now()
  ) {
    await env.TELEGRAM_VERIFY.delete(
      key
    );


    return errorPage(
      "验证链接过期",

      "请重新申请加入群组。"
    );
  }


  /*
   * 防重复
   */
  if (
    record.verified
  ) {
    return errorPage(
      "验证链接已经使用",

      "这个验证链接已经完成验证。"
    );
  }


  /*
   * =====================================================
   * Cloudflare Turnstile 服务端验证
   * =====================================================
   */

  const turnstileResponse =
    await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",

      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded",
        },

        body:
          new URLSearchParams({
            secret:
              env.TURNSTILE_SECRET_KEY,

            response:
              turnstileToken,

            remoteip:
              ip,
          }),
      }
    );


  let turnstileResult;


  try {
    turnstileResult =
      await turnstileResponse.json();
  } catch {
    return errorPage(
      "验证失败",

      "Turnstile 服务响应异常。"
    );
  }


  /*
   * Turnstile 失败
   */
  if (
    !turnstileResult.success
  ) {
    console.error(
      "Turnstile validation failed:",

      turnstileResult
    );


    const errors =
      (
        turnstileResult[
          "error-codes"
        ] || []
      ).join(", ");


    return errorPage(
      "验证失败",

      `Turnstile 验证失败：${
        errors ||
        "unknown"
      }`
    );
  }


  /*
   * Hostname 校验
   */
  const hostname =
    new URL(request.url)
      .hostname;


  if (
    turnstileResult.hostname &&
    turnstileResult.hostname !==
      hostname
  ) {
    return errorPage(
      "验证失败",

      "Turnstile 验证来源不正确。"
    );
  }


  /*
   * 再次读取 KV
   */
  const latestRecord =
    await env.TELEGRAM_VERIFY.get(
      key,

      "json"
    );


  if (!latestRecord) {
    return errorPage(
      "验证失败",

      "验证请求已经失效。"
    );
  }


  /*
   * 再次检查过期
   */
  if (
    latestRecord.expiresAt <
    Date.now()
  ) {
    await env.TELEGRAM_VERIFY.delete(
      key
    );


    return errorPage(
      "验证过期",

      "请重新申请加入群组。"
    );
  }


  /*
   * 再次检查重复
   */
  if (
    latestRecord.verified
  ) {
    return errorPage(
      "验证链接已经使用",

      "这个验证链接已经完成验证。"
    );
  }


  /*
   * =====================================================
   * 标记验证成功
   * =====================================================
   */

  latestRecord.verified =
    true;


  latestRecord.verifiedAt =
    Date.now();


  /*
   * 暂时保留 60 秒
   *
   * 防止 Telegram API 操作过程中
   * 出现问题无法排查
   */
  await env.TELEGRAM_VERIFY.put(
    key,

    JSON.stringify(
      latestRecord
    ),

    {
      expirationTtl:
        60,
    }
  );


  /*
   * =====================================================
   * 批准 Telegram 入群
   * =====================================================
   */

  const approveResult =
    await telegram(
      "approveChatJoinRequest",

      {
        chat_id:
          latestRecord.chatId,

        user_id:
          latestRecord.userId,
      },

      env
    );


  /*
   * Telegram 批准失败
   */
  if (
    !approveResult.ok
  ) {
    console.error(
      "approveChatJoinRequest failed:",

      approveResult
    );


    /*
     * 恢复验证状态
     *
     * 允许用户重新提交
     */
    latestRecord.verified =
      false;


    await env.TELEGRAM_VERIFY.put(
      key,

      JSON.stringify(
        latestRecord
      ),

      {
        expirationTtl:
          60,
      }
    );


    return errorPage(
      "Telegram 操作失败",

      "验证已经通过，但是 Telegram 暂时无法批准入群申请，请稍后重试。"
    );
  }


  /*
   * =====================================================
   * 成功
   * =====================================================
   */

  /*
   * 立即删除验证 Token
   *
   * 防止再次使用
   */
  await env.TELEGRAM_VERIFY.delete(
    key
  );


  /*
   * 删除用户退出记录
   */
  await env.TELEGRAM_VERIFY.delete(
    `left:${latestRecord.chatId}:${latestRecord.userId}`
  );


  return htmlPage(
    "验证成功",

    `
      <div
        class="success"
      >

        <h1>
          ✅ 验证成功
        </h1>

        <p>
          人机验证已经通过。
        </p>

        <p>
          Telegram 入群申请已经批准。
        </p>

        <p>
          现在可以返回 Telegram。
        </p>

      </div>
    `
  );
}


/*
 * =========================================================
 * IP 限流
 * =========================================================
 */

function getClientIP(
  request
) {
  return (
    request.headers.get(
      "CF-Connecting-IP"
    ) ||
    "unknown"
  );
}


async function checkIPRateLimit(
  ip,
  env
) {
  /*
   * 理论上 Cloudflare
   * 应该总能提供 CF-Connecting-IP
   */
  if (
    ip === "unknown"
  ) {
    return true;
  }


  /*
   * 当前时间桶
   */
  const bucket =
    Math.floor(
      Date.now() /
        (
          IP_WINDOW *
          1000
        )
    );


  const key =
    `ratelimit:${ip}:${bucket}`;


  const current =
    await env.TELEGRAM_VERIFY.get(
      key,

      "json"
    );


  const count =
    current?.count ||
    0;


  /*
   * 超过限制
   */
  if (
    count >= IP_LIMIT
  ) {
    return false;
  }


  /*
   * 增加次数
   */
  await env.TELEGRAM_VERIFY.put(
    key,

    JSON.stringify({
      count:
        count + 1,
    }),

    {
      expirationTtl:
        IP_WINDOW + 60,
    }
  );


  return true;
}


/*
 * =========================================================
 * Telegram API
 * =========================================================
 */

async function telegram(
  method,
  body,
  env
) {
  const response =
    await fetch(
      `${TELEGRAM_API}/bot${env.BOT_TOKEN}/${method}`,

      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",
        },

        body:
          JSON.stringify(
            body
          ),
      }
    );


  return await response.json();
}


/*
 * =========================================================
 * HTML
 * =========================================================
 */

function htmlPage(
  title,
  body
) {
  return new Response(
    `<!DOCTYPE html>

<html lang="zh-CN">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<title>
${escapeHtml(title)}
</title>

<style>

* {
  box-sizing: border-box;
}

body {

  margin: 0;

  min-height: 100vh;

  display: flex;

  justify-content: center;

  align-items: center;

  padding: 20px;

  background: #f4f6f8;

  font-family:
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
}

.card {

  width: 100%;

  max-width: 430px;

  background: white;

  border-radius: 18px;

  padding: 32px;

  text-align: center;

  box-shadow:
    0 10px 40px
    rgba(0,0,0,.08);
}

h1 {

  margin-top: 0;

}

p {

  color: #666;

  line-height: 1.7;
}

.cf-turnstile {

  display: flex;

  justify-content: center;

  margin: 24px 0;
}

button {

  width: 100%;

  border: none;

  border-radius: 10px;

  padding: 14px;

  font-size: 16px;

  cursor: pointer;

  background: #2481cc;

  color: white;
}

button:hover {

  opacity: .9;
}

.success {

  color: #198754;
}

.error {

  color: #dc3545;
}

.status {

  min-height: 20px;

  margin-bottom: 15px;

  font-size: 13px;

  color: #777;
}

</style>

</head>

<body>

<div class="card">

${body}

</div>

</body>

</html>`,

    {
      headers: {
        "Content-Type":
          "text/html; charset=UTF-8",

        "Cache-Control":
          "no-store",

        "X-Content-Type-Options":
          "nosniff",
      },
    }
  );
}


/*
 * =========================================================
 * Error Page
 * =========================================================
 */

function errorPage(
  title,
  message
) {
  return htmlPage(
    title,

    `
      <div class="error">

        <h1>
          ❌ ${escapeHtml(title)}
        </h1>

        <p>
          ${escapeHtml(message)}
        </p>

      </div>
    `
  );
}


/*
 * =========================================================
 * JSON
 * =========================================================
 */

function json(
  data,
  status = 200
) {
  return new Response(
    JSON.stringify(data),

    {
      status,

      headers: {
        "Content-Type":
          "application/json",

        "Cache-Control":
          "no-store",
      },
    }
  );
}


/*
 * =========================================================
 * HTML Escape
 * =========================================================
 */

function escapeHtml(
  value
) {
  return String(value)

    .replaceAll(
      "&",
      "&amp;"
    )

    .replaceAll(
      "<",
      "&lt;"
    )

    .replaceAll(
      ">",
      "&gt;"
    )

    .replaceAll(
      '"',
      "&quot;"
    )

    .replaceAll(
      "'",
      "&#039;"
    );
}
