using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Shop.Api.Common;
using Shop.Api.Common.Auth;
using Shop.Api.Common.Paging;
using Shop.Api.Modules.Orders.Dtos;

namespace Shop.Api.Modules.Orders;

[ApiController]
[Route(ApiRoutes.V1 + "/orders")]
[Authorize] // every endpoint needs a logged-in user
public class OrdersController : ControllerBase
{
    private readonly OrdersService _ordersService;

    public OrdersController(OrdersService ordersService)
    {
        _ordersService = ordersService;
    }

    /// <summary>Places an order (customers only).</summary>
    [HttpPost]
    [Authorize(Roles = Roles.Customer)]
    [ProducesResponseType<OrderResponse>(StatusCodes.Status201Created)]
    public async Task<IActionResult> Create(CreateOrderRequest request, CancellationToken ct)
    {
        var order = await _ordersService.CreateAsync(request, ct);
        return CreatedAtAction(nameof(GetById), new { id = order.Id }, order);
    }

    /// <summary>A customer gets their own orders; an admin gets all orders.</summary>
    [HttpGet]
    public Task<PagedResponse<OrderSummaryResponse>> List([FromQuery] OrderQuery query, CancellationToken ct) =>
        _ordersService.ListAsync(query, ct);

    /// <summary>One order with its items and status history. Another customer's order returns 404.</summary>
    [HttpGet("{id:guid}")]
    public Task<OrderResponse> GetById(Guid id, CancellationToken ct) =>
        _ordersService.GetByIdAsync(id, ct);

    /// <summary>Moves an order to its next status (admin only; a customer gets 403).</summary>
    [HttpPatch("{id:guid}/status")]
    [Authorize(Roles = Roles.Admin)]
    public Task<OrderResponse> ChangeStatus(Guid id, ChangeOrderStatusRequest request, CancellationToken ct) =>
        _ordersService.ChangeStatusAsync(id, request.Status!.Value, ct);
}
