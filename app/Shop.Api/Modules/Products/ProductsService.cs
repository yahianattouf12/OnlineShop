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
    private static readonly TimeSpan MetadataCacheLifetime = TimeSpan.FromSeconds(60);

    // Product list pages: the same 60-second limit. Adding a product switches every list to a new
    // generation at once, so no page is searched for and deleted; the old ones simply expire.
    private static readonly TimeSpan ListCacheLifetime = TimeSpan.FromSeconds(60);
    private const string ListGenerationKey = "product:list:generation";

    private readonly ProductsDbContext _db;
    private readonly IImageStorage _imageStorage;
    private readonly IInventoryService _inventory; // the stock lives in the inventory service, not in our database
    private readonly ILogger<ProductsService> _logger;
    private readonly IDistributedCache? _metadataCache;

    public ProductsService(
        ProductsDbContext db,
        IImageStorage imageStorage,
        IInventoryService inventory,
        ILogger<ProductsService> logger,
        IDistributedCache? metadataCache = null)
    {
        _db = db;
        _imageStorage = imageStorage;
        _inventory = inventory;
        _logger = logger;
        _metadataCache = metadataCache;
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

        // Only after the row is saved: a list read in between is stored under the old generation, which nobody reads again.
        await InvalidateProductListsAsync();

        _logger.LogInformation("Product {ProductId} created in category {Category}", product.Id, product.Category);
        return ToResponse(product);
    }

    public async Task<PagedResponse<ProductResponse>> ListAsync(ProductQuery query, CancellationToken ct)
    {
        var category = string.IsNullOrWhiteSpace(query.Category) ? null : NormalizeCategory(query.Category);
        if (_metadataCache is null)
            return await QueryListAsync(category, query.Page, query.PageSize, ct);

        // The list is the same for every visitor and holds no stock, so one cached copy serves everyone.
        string key;
        try
        {
            var generation = await GetListGenerationAsync(ct);
            key = $"product:list:v1:{generation}:{Uri.EscapeDataString(category ?? "all")}:{query.Page}:{query.PageSize}";
            var cached = await _metadataCache.GetAsync(key, ct);
            if (cached is not null && JsonSerializer.Deserialize<PagedResponse<ProductResponse>>(cached) is { } page)
                return page;
        }
        catch (Exception error) when (error is RedisException or TimeoutException or JsonException)
        {
            _logger.LogWarning(error, "Could not read a cached product list");
            return await QueryListAsync(category, query.Page, query.PageSize, ct);
        }

        var result = await QueryListAsync(category, query.Page, query.PageSize, ct);
        try
        {
            var options = new DistributedCacheEntryOptions { AbsoluteExpirationRelativeToNow = ListCacheLifetime };
            await _metadataCache.SetAsync(key, JsonSerializer.SerializeToUtf8Bytes(result), options, ct);
        }
        catch (Exception error) when (error is RedisException or TimeoutException)
        {
            _logger.LogWarning(error, "Could not cache a product list");
        }

        return result;
    }

    private async Task<PagedResponse<ProductResponse>> QueryListAsync(string? category, int page, int pageSize, CancellationToken ct)
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

        return PagedResponse<ProductResponse>.Create(
            items.Select(ToResponse).ToList(), page, pageSize, totalCount);
    }

    public async Task<ProductResponse> GetByIdAsync(Guid id, CancellationToken ct)
    {
        var metadata = await GetProductMetadataAsync(id, ct);

        // Ask the inventory service how many are left. If it is down or too slow, the product page
        // still works: we show the product without its stock (null) instead of failing the whole page.
        int? stock;
        try
        {
            stock = await _inventory.GetStockAsync(id, ct);
        }
        catch (ServiceUnavailableException)
        {
            stock = null;
        }

        return metadata with { Stock = stock };
    }

    public async Task<StockResponse> SetStockAsync(Guid id, int quantity, CancellationToken ct)
    {
        await FindAsync(id, ct); // 404 for a product that does not exist

        var stock = await _inventory.SetStockAsync(id, quantity, ct);
        await InvalidateProductMetadataAsync(id);
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

    private async Task<ProductResponse> GetProductMetadataAsync(Guid id, CancellationToken ct)
    {
        if (_metadataCache is null)
            return ToResponse(await FindAsync(id, ct));

        var key = MetadataCacheKey(id);
        try
        {
            var cached = await _metadataCache.GetAsync(key, ct);
            if (cached is not null && JsonSerializer.Deserialize<ProductResponse>(cached) is { } metadata)
                return metadata;
        }
        catch (Exception error) when (error is RedisException or TimeoutException or JsonException)
        {
            _logger.LogWarning(error, "Could not read cached metadata for product {ProductId}", id);
            return ToResponse(await FindAsync(id, ct));
        }

        var product = ToResponse(await FindAsync(id, ct));
        try
        {
            var options = new DistributedCacheEntryOptions
            {
                AbsoluteExpirationRelativeToNow = MetadataCacheLifetime,
            };
            await _metadataCache.SetAsync(key, JsonSerializer.SerializeToUtf8Bytes(product), options, ct);
        }
        catch (Exception error) when (error is RedisException or TimeoutException)
        {
            _logger.LogWarning(error, "Could not cache metadata for product {ProductId}", id);
        }

        return product;
    }

    private async Task InvalidateProductMetadataAsync(Guid id)
    {
        if (_metadataCache is null)
            return;

        try
        {
            // The inventory write succeeded. Attempt eviction even if the client disconnects.
            await _metadataCache.RemoveAsync(MetadataCacheKey(id), CancellationToken.None);
        }
        catch (Exception error) when (error is RedisException or TimeoutException)
        {
            _logger.LogWarning(error, "Could not evict cached metadata for product {ProductId}", id);
        }
    }

    private static string MetadataCacheKey(Guid id) => $"product:metadata:v1:{id:D}";

    /// <summary>The current list generation. Created on first use, and again if Redis restarted and lost it.</summary>
    private async Task<string> GetListGenerationAsync(CancellationToken ct)
    {
        var cache = _metadataCache!; // only called when Redis is configured
        var generation = await cache.GetStringAsync(ListGenerationKey, ct);
        if (generation is not null)
            return generation;

        generation = Guid.NewGuid().ToString("N");
        await cache.SetStringAsync(ListGenerationKey, generation, ct);
        return generation;
    }

    private async Task InvalidateProductListsAsync()
    {
        if (_metadataCache is null)
            return;

        try
        {
            // The product is saved. Switch generations even if the client disconnects.
            await _metadataCache.SetStringAsync(ListGenerationKey, Guid.NewGuid().ToString("N"), CancellationToken.None);
        }
        catch (Exception error) when (error is RedisException or TimeoutException)
        {
            // The new product then appears once the cached pages expire, within ListCacheLifetime.
            _logger.LogWarning(error, "Could not invalidate the cached product lists");
        }
    }

    private async Task<Product> FindAsync(Guid id, CancellationToken ct) =>
        await _db.Products.AsNoTracking().SingleOrDefaultAsync(p => p.Id == id, ct)
        ?? throw new NotFoundException($"Product {id} was not found.");

    private static string NormalizeCategory(string category) => category.Trim().ToLowerInvariant();

    private static ProductResponse ToResponse(Product p) => new(
        p.Id, p.Name, p.Description, p.Price, p.Category,
        $"/{ApiRoutes.V1}/products/{p.Id}/image", p.CreatedAt);
}
