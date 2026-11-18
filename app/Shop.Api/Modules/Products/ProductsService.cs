using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Distributed;
using Shop.Api.Common;
using Shop.Api.Common.Errors;
using Shop.Api.Common.Paging;
using Shop.Api.Common.Storage;
using Shop.Api.Integrations.Inventory;
using Shop.Api.Modules.Products.Dtos;
using StackExchange.Redis;

namespace Shop.Api.Modules.Products;

public class ProductsService
{
    // Requirement 3: how long a cached copy may live (its TTL). Even if we forget to delete an entry,
    // it can never be older than this.
    private static readonly TimeSpan CacheLifetime = TimeSpan.FromSeconds(60);

    // Every list key contains this "generation". A new product changes it, so all old list keys are
    // simply never asked for again (and Redis removes them when their TTL ends).
    private const string ListGenerationKey = "products:list:generation";

    // When Redis does not answer, every read would wait for its timeout (about 3 s per request, measured).
    // So after a Redis error, reads skip Redis for this long and go straight to the database
    // (a simple "circuit breaker"). Deletes are still always tried: they must never be skipped.
    private static readonly TimeSpan RedisPause = TimeSpan.FromSeconds(30);
    private static long _skipRedisUntilTicks; // static: shared by all requests (the service itself is per request)

    private readonly ProductsDbContext _db;
    private readonly IImageStorage _imageStorage;
    private readonly IInventoryService _inventory; // the stock lives in the inventory service, not in our database
    private readonly ILogger<ProductsService> _logger;
    private readonly IDistributedCache? _cache; // Redis, or null when Redis is not configured

    /// <summary>
    /// How the last cached read was answered: "HIT" (from Redis), "MISS" (from the database, now cached) or
    /// "BYPASS" (Redis is off or paused). The controller sends it as the X-Cache header, so the effect of the
    /// cache can be seen on every response (Requirement 3).
    /// </summary>
    public string? LastCacheStatus { get; private set; }

    public ProductsService(
        ProductsDbContext db,
        IImageStorage imageStorage,
        IInventoryService inventory,
        ILogger<ProductsService> logger,
        IDistributedCache? cache = null)
    {
        _db = db;
        _imageStorage = imageStorage;
        _inventory = inventory;
        _logger = logger;
        _cache = cache;
    }

    public async Task<ProductResponse> CreateAsync(CreateProductRequest request, CancellationToken ct)
    {
        // 1. The file goes to the disk first; the database only keeps its name.
        var image = await _imageStorage.SaveAsync(request.Image!, ct);

        var product = new Product
        {
            Id = Guid.NewGuid(),
            Name = request.Name.Trim(),
            Description = request.Description.Trim(),
            Price = request.Price,
            Category = NormalizeCategory(request.Category),
            ImageFileName = image.FileName,
            ImageContentType = image.ContentType,
            CreatedAt = DateTime.UtcNow,
        };

        // 2. If saving the row fails, delete the file again, so no orphan images pile up on the disk.
        try
        {
            _db.Products.Add(product);
            await _db.SaveChangesAsync(ct);
        }
        catch
        {
            _imageStorage.Delete(image.FileName);
            throw;
        }

        // 3. Only AFTER the row is saved: the cached lists do not have the new product, so drop them.
        await ForgetListsAsync();

        _logger.LogInformation("Product {ProductId} created in category {Category}", product.Id, product.Category);
        return ToResponse(product);
    }

    /// <summary>Changes a product's name, description, price and category (admin only).</summary>
    public async Task<ProductResponse> UpdateAsync(Guid id, UpdateProductRequest request, CancellationToken ct)
    {
        // Tracked (no AsNoTracking): EF sees the changes and writes them in SaveChanges.
        var product = await _db.Products.SingleOrDefaultAsync(p => p.Id == id, ct)
            ?? throw new NotFoundException($"Product {id} was not found.");

        product.Name = request.Name.Trim();
        product.Description = request.Description.Trim();
        product.Price = request.Price;
        product.Category = NormalizeCategory(request.Category);
        await _db.SaveChangesAsync(ct);

        // The old copies in Redis are wrong now: delete them, so the very next read sees the change.
        await ForgetAsync(DetailsKey(id));
        await ForgetListsAsync();

        _logger.LogInformation("Product {ProductId} updated", id);
        return ToResponse(product);
    }

    public async Task<PagedResponse<ProductResponse>> ListAsync(ProductQuery query, CancellationToken ct)
    {
        var category = string.IsNullOrWhiteSpace(query.Category) ? null : NormalizeCategory(query.Category);

        // The list is the same for every visitor and has no stock in it, so one cached copy can serve everyone.
        var generation = await GetListGenerationAsync(ct);
        var key = $"products:list:{generation}:{category ?? "all"}:{query.Page}:{query.PageSize}";

        return await GetOrLoadAsync(key, () => LoadListAsync(category, query.Page, query.PageSize, ct), ct);
    }

    public async Task<ProductResponse> GetByIdAsync(Guid id, CancellationToken ct)
    {
        // Name, price, ... come from Redis when we have them (they rarely change).
        var product = await GetOrLoadAsync(DetailsKey(id), async () => ToResponse(await FindAsync(id, ct)), ct);

        // The stock is NEVER cached: it changes with every order and must be exact.
        // If the inventory service is down or too slow, the product page still works: we show the product
        // without its stock (null) instead of failing the whole page.
        int? stock;
        try
        {
            stock = await _inventory.GetStockAsync(id, ct);
        }
        catch (ServiceUnavailableException)
        {
            stock = null;
        }

        return product with { Stock = stock };
    }

    public async Task<StockResponse> SetStockAsync(Guid id, int quantity, CancellationToken ct)
    {
        await FindAsync(id, ct); // 404 for a product that does not exist

        var stock = await _inventory.SetStockAsync(id, quantity, ct);
        _logger.LogInformation("Stock of product {ProductId} set to {Stock}", id, stock);
        return new StockResponse(id, stock);
    }

    public async Task<(Stream Content, string ContentType)> GetImageAsync(Guid id, CancellationToken ct)
    {
        var product = await FindAsync(id, ct);
        var stream = _imageStorage.OpenRead(product.ImageFileName)
            ?? throw new NotFoundException($"The image of product {id} was not found.");
        return (stream, product.ImageContentType);
    }

    private async Task<PagedResponse<ProductResponse>> LoadListAsync(string? category, int page, int pageSize, CancellationToken ct)
    {
        var products = _db.Products.AsNoTracking();

        if (category is not null)
            products = products.Where(p => p.Category == category);

        var totalCount = await products.CountAsync(ct);

        // A stable order is required for paging; otherwise an item could show up on two pages.
        var items = await products
            .OrderByDescending(p => p.CreatedAt)
            .ThenBy(p => p.Id)
            .Skip((page - 1) * pageSize)
            .Take(pageSize)
            .ToListAsync(ct);

        return PagedResponse<ProductResponse>.Create(items.Select(ToResponse).ToList(), page, pageSize, totalCount);
    }

    // ---------- Redis helpers (Requirement 3) ----------

    /// <summary>
    /// "Cache-aside": look in Redis first. On a miss, load from the database and keep a copy for CacheLifetime.
    /// Redis is only a speed-up: if it is down, we log it and use the database, the shop keeps working.
    /// </summary>
    private async Task<T> GetOrLoadAsync<T>(string key, Func<Task<T>> load, CancellationToken ct)
    {
        if (_cache is null || RedisPaused())
        {
            LastCacheStatus = "BYPASS";
            return await load();
        }

        try
        {
            var cached = await _cache.GetAsync(key, ct);
            if (cached is not null)
            {
                LastCacheStatus = "HIT";
                return JsonSerializer.Deserialize<T>(cached)!; // a hit: no database at all
            }
        }
        catch (Exception e) when (e is RedisException or TimeoutException or JsonException)
        {
            _logger.LogWarning(e, "Could not read {Key} from Redis; using the database", key);
            if (e is not JsonException)
                PauseRedis();
            LastCacheStatus = "BYPASS";
            return await load();
        }

        LastCacheStatus = "MISS";
        var value = await load(); // a miss
        try
        {
            var options = new DistributedCacheEntryOptions { AbsoluteExpirationRelativeToNow = CacheLifetime };
            await _cache.SetAsync(key, JsonSerializer.SerializeToUtf8Bytes(value), options, ct);
        }
        catch (Exception e) when (e is RedisException or TimeoutException)
        {
            _logger.LogWarning(e, "Could not save {Key} in Redis", key);
            PauseRedis();
        }

        return value;
    }

    private static bool RedisPaused() => DateTime.UtcNow.Ticks < Interlocked.Read(ref _skipRedisUntilTicks);

    private static void PauseRedis() =>
        Interlocked.Exchange(ref _skipRedisUntilTicks, DateTime.UtcNow.Add(RedisPause).Ticks);

    private async Task<string> GetListGenerationAsync(CancellationToken ct)
    {
        if (_cache is null || RedisPaused())
            return "none";

        try
        {
            var generation = await _cache.GetStringAsync(ListGenerationKey, ct);
            if (generation is not null)
                return generation;

            // First use (or Redis restarted and lost it): start a new generation.
            generation = Guid.NewGuid().ToString("N");
            await _cache.SetStringAsync(ListGenerationKey, generation, ct);
            return generation;
        }
        catch (Exception e) when (e is RedisException or TimeoutException)
        {
            _logger.LogWarning(e, "Could not read the list generation from Redis");
            PauseRedis();
            return "none"; // Redis is paused now, so GetOrLoadAsync goes straight to the database
        }
    }

    /// <summary>A new generation: from now on every list key has a new name, so no old list is ever read again.</summary>
    private async Task ForgetListsAsync()
    {
        if (_cache is null)
            return;

        try
        {
            // CancellationToken.None: the data is already saved, so finish this even if the client went away.
            await _cache.SetStringAsync(ListGenerationKey, Guid.NewGuid().ToString("N"), CancellationToken.None);
        }
        catch (Exception e) when (e is RedisException or TimeoutException)
        {
            // Then the old lists live until their TTL ends (at most CacheLifetime).
            _logger.LogWarning(e, "Could not start a new product list generation in Redis");
        }
    }

    private async Task ForgetAsync(string key)
    {
        if (_cache is null)
            return;

        try
        {
            await _cache.RemoveAsync(key, CancellationToken.None);
        }
        catch (Exception e) when (e is RedisException or TimeoutException)
        {
            _logger.LogWarning(e, "Could not delete {Key} from Redis", key);
        }
    }

    private static string DetailsKey(Guid id) => $"products:details:{id}";

    private async Task<Product> FindAsync(Guid id, CancellationToken ct) =>
        await _db.Products.AsNoTracking().SingleOrDefaultAsync(p => p.Id == id, ct)
        ?? throw new NotFoundException($"Product {id} was not found.");

    private static string NormalizeCategory(string category) => category.Trim().ToLowerInvariant();

    private static ProductResponse ToResponse(Product p) => new(
        p.Id, p.Name, p.Description, p.Price, p.Category,
        $"/{ApiRoutes.V1}/products/{p.Id}/image", p.CreatedAt);
}
