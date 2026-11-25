using System.ComponentModel.DataAnnotations;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;
using PusherServer;
using Shop.Api.Common;
using Shop.Api.Common.Errors;
using Shop.Api.Common.Realtime;

namespace Shop.Api.Modules.Orders;

/// <summary>Requirement 4: what the browser needs to use the live channels.</summary>
[ApiController]
[Route(ApiRoutes.V1 + "/realtime")]
public class RealtimeController : ControllerBase
{
    private readonly OrdersService _ordersService;
    private readonly IPusher _pusher;

    public RealtimeController(OrdersService ordersService, IPusher pusher)
    {
        _ordersService = ordersService;
        _pusher = pusher;
    }

    /// <summary>The public app key, so the browser can connect to Soketi. (The secret never leaves the server.)</summary>
    [HttpGet("config")]
    [AllowAnonymous]
    public RealtimeConfigResponse Config([FromServices] IOptions<RealtimeOptions> options) => new(options.Value.Key);

    /// <summary>
    /// The browser calls this before it joins a private channel. We check WHO it is (the JWT, [Authorize]) and
    /// WHETHER it may join (admin channel: admins only; order channel: the order's owner only). Only then we
    /// sign "this socket may join this channel" with the secret. Soketi refuses a join without a valid signature.
    /// </summary>
    [HttpPost("auth")]
    [Authorize]
    public async Task<IActionResult> Authorize(ChannelAuthRequest request, CancellationToken ct)
    {
        if (!await _ordersService.CanWatchChannelAsync(request.ChannelName, ct))
            throw new ForbiddenException("You may not listen to this channel.");

        var authorization = _pusher.AuthorizeChannel(request.ChannelName, request.SocketId);
        return Content(authorization.ToJson(), "application/json");
    }
}

/// <summary>Sent by pusher-js (through our own handler, so it carries our JWT).</summary>
public class ChannelAuthRequest
{
    /// <summary>Soketi's id for this one browser connection, e.g. "123456.7890123".</summary>
    [Required, RegularExpression(@"^\d+\.\d+$")]
    public string SocketId { get; set; } = "";

    [Required, MaxLength(100)]
    public string ChannelName { get; set; } = "";
}

public record RealtimeConfigResponse(string Key);
