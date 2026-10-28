using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Shop.Api.Common;
using Shop.Api.Common.Auth;
using Shop.Api.Common.Paging;
using Shop.Api.Common.Storage;
using Shop.Api.Modules.Products.Dtos;

namespace Shop.Api.Modules.Products;

[ApiController]
[Route(ApiRoutes.V1 + "/products")]
public class ProductsController : ControllerBase
{
    private readonly ProductsService _productsService;

    public ProductsController(ProductsService productsService)
    {
        _productsService = productsService;
    }

    /// <summary>Adds a product with its image (admin only).</summary>
    [HttpPost]
    [Authorize(Roles = Roles.Admin)]
    [Consumes("multipart/form-data")]
    // Rejects huge bodies (413) before they are even read: the 5 MB image plus some room for the text fields.
    [RequestSizeLimit(ImageFileAttribute.MaxBytes + 1024 * 1024)]
    [ProducesResponseType<ProductResponse>(StatusCodes.Status201Created)]
    public async Task<IActionResult> Create([FromForm] CreateProductRequest request, CancellationToken ct)
    {
        var product = await _productsService.CreateAsync(request, ct);
        return CreatedAtAction(nameof(GetById), new { id = product.Id }, product);
    }

    /// <summary>Lists products, newest first, with an optional category filter and paging.</summary>
    [HttpGet]
    public Task<PagedResponse<ProductResponse>> List([FromQuery] ProductQuery query, CancellationToken ct) =>
        _productsService.ListAsync(query, ct);

    [HttpGet("{id:guid}")]
    public Task<ProductResponse> GetById(Guid id, CancellationToken ct) =>
        _productsService.GetByIdAsync(id, ct);

    /// <summary>The product's image file.</summary>
    [HttpGet("{id:guid}/image")]
    public async Task<IActionResult> GetImage(Guid id, CancellationToken ct)
    {
        var (content, contentType) = await _productsService.GetImageAsync(id, ct);
        return File(content, contentType);
    }
}
