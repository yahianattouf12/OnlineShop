using Microsoft.EntityFrameworkCore;
using Shop.Api.Common.Auth;
using Shop.Api.Common.Errors;
using Shop.Api.Common.Paging;
using Shop.Api.Modules.Notifications.Contracts;
using Shop.Api.Modules.Orders.Dtos;
using Shop.Api.Modules.Products.Contracts;
using Shop.Api.Integrations.Inventory;
using Shop.Messaging;

namespace Shop.Api.Modules.Orders;

public class OrdersService
{
    private readonly OrdersDbContext _db;
    private readonly OrdersDbContext _replicaDb; // read-only copy, only for the admin order list
    private readonly IProductCatalog _productCatalog; // the Products module's public door, NOT ProductsDbContext
    private readonly IInventoryService _inventory; // the inventory service, over gRPC

    private readonly INotificationService _notifications; // the Notifications module's public door
    private readonly ICurrentUser _currentUser;
    private readonly ILogger<OrdersService> _logger;

    public OrdersService(
        OrdersDbContext db,
        [FromKeyedServices(OrdersModule.ReadReplica)] OrdersDbContext replicaDb,
        IProductCatalog productCatalog,
        INotificationService notifications,
        IInventoryService inventory,
        ICurrentUser currentUser,
        ILogger<OrdersService> logger)
    {
        _db = db;
        _replicaDb = replicaDb;
        _productCatalog = productCatalog;
        _notifications = notifications;
        _inventory = inventory;
        _currentUser = currentUser;
        _logger = logger;
    }

    public async Task<OrderResponse> CreateAsync(CreateOrderRequest request, CancellationToken ct)
    {
        // 1. Who is ordering? From the token, never from the request.
        var userId = _currentUser.Id;

        // Requirement 4: the confirmation email goes to this address (also from the token).
        var email = _currentUser.Email
            ?? throw new UnauthorizedException("Your session is from before an update. Please log in again.");

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

        // 4. Reserve the stock of ALL the items in ONE call to the inventory service: all or nothing.
        //    The order is saved only if the inventory says yes.
        await ReserveStockAsync(order);

        // 5. The order, its items, its first history entry AND the event for the email worker (Requirement 4)
        //    are saved in ONE transaction: all or nothing. The event waits in the outbox until OutboxPublisher
        //    hands it to RabbitMQ, so the customer never waits for the email.
        //    If saving fails, the stock we just reserved must go back to the inventory (compensation).
        _db.Orders.Add(order);
        _db.OutboxMessages.Add(OutboxMessage.OrderCreated(new OrderCreatedEvent(
            Guid.NewGuid(),
            order.Id,
            email,
            order.TotalAmount,
            order.Items.Select(i => new OrderCreatedItem(i.ProductName, i.Quantity, i.UnitPrice)).ToList(),
            now)));

        try
        {
            await _db.SaveChangesAsync(ct);
        }
        catch (Exception e)
        {
            _logger.LogError(e, "Saving order {OrderId} failed after its stock was reserved; releasing the stock", order.Id);
            await TryReleaseStockAsync(order.Id);
            throw;
        }

        _logger.LogInformation("Order {OrderId} created by user {UserId}, total {Total}", order.Id, userId, order.TotalAmount);

        // 6. Tell the customer. Only after the order is safely saved.
        await TryNotifyAsync(userId, $"We received your order {ShortId(order.Id)} (total {order.TotalAmount:0.00}).", order.Id);

        return ToResponse(order);
    }

    public async Task<PagedResponse<OrderSummaryResponse>> ListAsync(OrderQuery query, CancellationToken ct)
    {
        // Requirement 3: the admin's list of ALL orders is read from the replica (a heavy read that is fine
        // a moment late). A customer's own list stays on the primary: the replica can lag a little, and a
        // customer must see the order they have just placed (read-your-own-writes).
        var orders = _currentUser.IsAdmin
            ? _replicaDb.Orders.AsNoTracking()
            : VisibleOrders();

        if (query.Status is { } status)
            orders = orders.Where(o => o.Status == status);

        // The old version (before Requirement 3) is kept in ListLegacyAsync below, to compare the two with k6.
        var totalCount = await orders.CountAsync(ct);

        // Requirement 3: FIRST pick the 10 orders of the page, THEN count their items.
        // Before, PostgreSQL counted the items of every skipped order too (100,000 counts for page 10,000).
        var page = orders
            .OrderByDescending(o => o.CreatedAt)
            .ThenBy(o => o.Id)
            .Skip((query.Page - 1) * query.PageSize)
            .Take(query.PageSize);

        var items = await page
            .OrderByDescending(o => o.CreatedAt) // the page keeps its order in the outer query too
            .ThenBy(o => o.Id)
            .Select(o => new OrderSummaryResponse(
                o.Id,
                o.UserId,
                o.Status,
                o.TotalAmount,
                o.Items.Count,
                o.Items.OrderBy(i => i.ProductName).Select(i => i.ProductId).ToList(),
                o.CreatedAt))
            .ToListAsync(ct);

        return PagedResponse<OrderSummaryResponse>.Create(items, query.Page, query.PageSize, totalCount);
        /** TO CHECK THE QUERY PLAN

            docker compose up -d --build app
            Invoke-RestMethod "http://localhost:8080/api/v1/orders?page=10000&pageSize=10" -Headers @{ Authorization = "Bearer $admin" } | Out-Null
            docker compose logs app --since 20s | Select-String -Context 0,16 "Executed DbCommand"
        */
    }

    /// <summary>
    /// Requirement 3 demo: the order list EXACTLY as it was before the fix, so "before" and "after" can be
    /// measured side by side with k6 (GET /orders/legacy vs GET /orders). Do not use it anywhere else.
    /// The problem: Select comes before Skip/Take, so EF puts the item count INSIDE the LIMIT/OFFSET query,
    /// and PostgreSQL counts the items of every skipped order too (100,000 counts for page 10,000).
    /// </summary>
    public async Task<PagedResponse<OrderSummaryResponse>> ListLegacyAsync(OrderQuery query, CancellationToken ct)
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
            .Select(o => new OrderSummaryResponse(
                o.Id,
                o.UserId,
                o.Status,
                o.TotalAmount,
                o.Items.Count,
                o.Items.OrderBy(i => i.ProductName).Select(i => i.ProductId).ToList(),
                o.CreatedAt))
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
    /// Asks the inventory to reserve every item of the order, under the order's id.
    /// CancellationToken.None: once the call is sent we must learn how it ended, even if the client
    /// disconnects, or stock could stay reserved for an order that does not exist. The deadline still applies.
    /// </summary>
    private async Task ReserveStockAsync(Order order)
    {
        IReadOnlyList<StockShortage> shortages;
        try
        {
            shortages = await _inventory.ReserveAsync(
                order.Id, order.Items.Select(i => new StockItem(i.ProductId, i.Quantity)), CancellationToken.None);
        }
        catch (ServiceUnavailableException)
        {
            // The deadline passed, so we do not know if the inventory reserved or not (its answer may just
            // be late). Release to be safe: it does nothing if nothing was reserved. The user gets the 503.
            await TryReleaseStockAsync(order.Id);
            throw;
        }

        if (shortages.Count == 0)
            return;

        var names = order.Items.ToDictionary(i => i.ProductId, i => i.ProductName);
        throw new ConflictException($"Not enough stock for: {string.Join(", ", shortages.Select(s => names[s.ProductId]))}.")
        {
            Extensions =
            {
                ["shortages"] = shortages
                    .Select(s => new { s.ProductId, ProductName = names[s.ProductId], s.Requested, s.Available })
                    .ToList(),
            },
        };
    }

    /// <summary>
    /// Best effort: gives the order's reserved stock back. A failure here is only logged, so the caller's
    /// real error still reaches the user. If it fails, the stock stays reserved until someone releases it by hand.
    /// </summary>
    private async Task TryReleaseStockAsync(Guid orderId)
    {
        try
        {
            await _inventory.ReleaseAsync(orderId, CancellationToken.None);
        }
        catch (Exception e)
        {
            _logger.LogError(e, "Could not release the stock of order {OrderId}", orderId);
        }
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
