using Microsoft.EntityFrameworkCore;
using Shop.Api.Common.Auth;
using Shop.Api.Common.Errors;
using Shop.Api.Common.Paging;
using Shop.Api.Modules.Notifications.Contracts;
using Shop.Api.Modules.Orders.Dtos;
using Shop.Api.Modules.Products.Contracts;

namespace Shop.Api.Modules.Orders;

public class OrdersService
{
    private readonly OrdersDbContext _db;
    private readonly IProductCatalog _productCatalog; // the Products module's public door, NOT ProductsDbContext
    private readonly INotificationService _notifications; // the Notifications module's public door
    private readonly ICurrentUser _currentUser;
    private readonly ILogger<OrdersService> _logger;

    public OrdersService(
        OrdersDbContext db,
        IProductCatalog productCatalog,
        INotificationService notifications,
        ICurrentUser currentUser,
        ILogger<OrdersService> logger)
    {
        _db = db;
        _productCatalog = productCatalog;
        _notifications = notifications;
        _currentUser = currentUser;
        _logger = logger;
    }

    public async Task<OrderResponse> CreateAsync(CreateOrderRequest request, CancellationToken ct)
    {
        // 1. Who is ordering? From the token, never from the request.
        var userId = _currentUser.Id;

        // 2. Ask the Products module for names and prices. Unknown products are rejected.
        var productIds = request.Items.Select(i => i.ProductId!.Value).ToList();
        var products = await _productCatalog.GetProductsAsync(productIds, ct);

        var missing = productIds.Where(id => !products.ContainsKey(id)).ToList();
        if (missing.Count > 0)
        {
            throw new BusinessRuleException("Some of the products do not exist.")
            {
                Extensions = { ["missingProductIds"] = missing },
            };
        }

        // 3. Build the order with a snapshot of each product's name and price, and calculate the total here.
        var now = DateTime.UtcNow;
        var order = new Order
        {
            Id = Guid.NewGuid(),
            UserId = userId,
            Status = OrderStatus.Pending,
            CreatedAt = now,
            UpdatedAt = now,
        };

        foreach (var item in request.Items)
        {
            var product = products[item.ProductId!.Value];
            order.Items.Add(new OrderItem
            {
                Id = Guid.NewGuid(),
                ProductId = product.Id,
                ProductName = product.Name,
                UnitPrice = product.Price,
                Quantity = item.Quantity,
            });
        }

        order.TotalAmount = order.Items.Sum(i => i.UnitPrice * i.Quantity);
        order.StatusHistory.Add(NewHistoryEntry(OrderStatus.Pending, now, userId));

        // 4. (Requirement 2) Reserve the quantities in the inventory service here, before saving.

        // 5. The order, its items and its first history entry are saved in ONE transaction: all or nothing.
        _db.Orders.Add(order);
        await _db.SaveChangesAsync(ct);

        _logger.LogInformation("Order {OrderId} created by user {UserId}, total {Total}", order.Id, userId, order.TotalAmount);

        // 6. Tell the customer. Only after the order is safely saved.
        await TryNotifyAsync(userId, $"We received your order {ShortId(order.Id)} (total {order.TotalAmount:0.00}).", order.Id);

        return ToResponse(order);
    }

    public async Task<PagedResponse<OrderSummaryResponse>> ListAsync(OrderQuery query, CancellationToken ct)
    {
        var orders = VisibleOrders();

        if (query.Status is { } status)
            orders = orders.Where(o => o.Status == status);

        var totalCount = await orders.CountAsync(ct);
        var items = await orders
            .OrderByDescending(o => o.CreatedAt)
            .ThenBy(o => o.Id)
            .Skip((query.Page - 1) * query.PageSize)
            .Take(query.PageSize)
            .Select(o => new OrderSummaryResponse(o.Id, o.UserId, o.Status, o.TotalAmount, o.Items.Count, o.CreatedAt))
            .ToListAsync(ct);

        return PagedResponse<OrderSummaryResponse>.Create(items, query.Page, query.PageSize, totalCount);
    }

    public async Task<OrderResponse> GetByIdAsync(Guid id, CancellationToken ct)
    {
        // VisibleOrders() already hides other customers' orders, so for them this is simply "not found".
        var order = await VisibleOrders()
            .Include(o => o.Items)
            .Include(o => o.StatusHistory)
            .AsSplitQuery()
            .SingleOrDefaultAsync(o => o.Id == id, ct)
            ?? throw new NotFoundException($"Order {id} was not found.");

        return ToResponse(order);
    }

    public async Task<OrderResponse> ChangeStatusAsync(Guid id, OrderStatus newStatus, CancellationToken ct)
    {
        // The controller already allows admins only. Checking again here means the rule
        // still holds if this method is ever called from somewhere else (defence in depth).
        if (!_currentUser.IsAdmin)
            throw new ForbiddenException("Only an admin can change the status of an order.");

        var order = await _db.Orders
            .Include(o => o.Items)
            .Include(o => o.StatusHistory)
            .AsSplitQuery()
            .SingleOrDefaultAsync(o => o.Id == id, ct)
            ?? throw new NotFoundException($"Order {id} was not found.");

        if (!OrderStatusRules.CanMove(order.Status, newStatus))
        {
            throw new BusinessRuleException($"An order cannot go from {order.Status} to {newStatus}.")
            {
                Extensions = { ["allowedNext"] = OrderStatusRules.NextOf(order.Status) },
            };
        }

        var now = DateTime.UtcNow;
        order.Status = newStatus;
        order.UpdatedAt = now;
        order.StatusHistory.Add(NewHistoryEntry(newStatus, now, _currentUser.Id));

        try
        {
            await _db.SaveChangesAsync(ct);
        }
        catch (DbUpdateConcurrencyException)
        {
            // Someone else changed this order between our read and our save.
            throw new ConflictException("The order was changed by someone else. Reload it and try again.");
        }

        _logger.LogInformation("Order {OrderId} moved to {Status} by admin {AdminId}", order.Id, newStatus, _currentUser.Id);

        // The notification goes to the order's owner (order.UserId), not to the admin who changed it.
        await TryNotifyAsync(order.UserId, $"Your order {ShortId(order.Id)} is now {newStatus}.", order.Id);

        return ToResponse(order);
    }

    /// <summary>
    /// THE protection against IDOR: every read of orders starts here. A customer only ever
    /// sees rows where UserId is their own id (from the token); an admin sees everything.
    /// </summary>
    private IQueryable<Order> VisibleOrders()
    {
        var orders = _db.Orders.AsNoTracking();
        if (_currentUser.IsAdmin)
            return orders;

        var userId = _currentUser.Id;
        return orders.Where(o => o.UserId == userId);
    }

    /// <summary>
    /// Best effort: the order is already saved, so a failed notification must not turn a successful
    /// order into an error for the customer. We log it instead. (Requirement 4 will make delivery reliable.)
    /// CancellationToken.None: finish the notification even if the client has already disconnected.
    /// </summary>
    private async Task TryNotifyAsync(Guid userId, string message, Guid orderId)
    {
        try
        {
            await _notifications.NotifyAsync(userId, message, orderId, CancellationToken.None);
        }
        catch (Exception e)
        {
            _logger.LogWarning(e, "Could not notify user {UserId} about order {OrderId}", userId, orderId);
        }
    }

    /// <summary>The first 8 characters of the id, enough for a human to recognise the order.</summary>
    private static string ShortId(Guid id) => id.ToString()[..8];

    private static OrderStatusChange NewHistoryEntry(OrderStatus status, DateTime at, Guid byUserId) => new()
    {
        Id = Guid.NewGuid(),
        Status = status,
        ChangedAt = at,
        ChangedByUserId = byUserId,
    };

    private static OrderResponse ToResponse(Order o) => new(
        o.Id,
        o.UserId,
        o.Status,
        o.TotalAmount,
        o.CreatedAt,
        o.UpdatedAt,
        o.Items
            .Select(i => new OrderItemResponse(i.ProductId, i.ProductName, i.UnitPrice, i.Quantity, i.UnitPrice * i.Quantity))
            .ToList(),
        o.StatusHistory
            .OrderBy(h => h.ChangedAt)
            .Select(h => new OrderStatusChangeResponse(h.Status, h.ChangedAt))
            .ToList());
}
