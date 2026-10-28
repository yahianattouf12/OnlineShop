using System.ComponentModel.DataAnnotations;
using Shop.Api.Common.Storage;

namespace Shop.Api.Modules.Products.Dtos;

/// <summary>Sent as multipart/form-data, because it carries a file.</summary>
public class CreateProductRequest
{
    [Required, MaxLength(200)]
    public string Name { get; set; } = "";

    [MaxLength(2000)]
    public string Description { get; set; } = "";

    [Range(0.01, 1_000_000)]
    public decimal Price { get; set; }

    [Required, MaxLength(50)]
    public string Category { get; set; } = "";

    [Required, ImageFile]
    public IFormFile? Image { get; set; }
}

/// <summary>GET /products?category=phones&amp;page=2&amp;pageSize=10</summary>
public class ProductQuery
{
    [MaxLength(50)]
    public string? Category { get; set; }

    // Capped so (Page - 1) * PageSize can never overflow an int (it would become a negative OFFSET → 500).
    [Range(1, 10_000)]
    public int Page { get; set; } = 1;

    // An upper limit, so nobody can ask for a million products in one request.
    [Range(1, 50)]
    public int PageSize { get; set; } = 10;
}

public record ProductResponse(
    Guid Id,
    string Name,
    string Description,
    decimal Price,
    string Category,
    string ImageUrl,
    DateTime CreatedAt);
