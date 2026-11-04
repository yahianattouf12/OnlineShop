using System.ComponentModel.DataAnnotations;

namespace Shop.Api.Integrations.Inventory;

/// <summary>The "Inventory" section of the configuration.</summary>
public class InventoryOptions
{
    public const string SectionName = "Inventory";

    /// <summary>Where the inventory gRPC service listens, e.g. http://inventory:50051 inside Docker.</summary>
    [Required, Url] public string Address { get; set; } = "";

    /// <summary>The deadline of EVERY call: after this the app stops waiting and answers 503.</summary>
    [Range(0.1, 30)] public double TimeoutSeconds { get; set; } = 2;
}