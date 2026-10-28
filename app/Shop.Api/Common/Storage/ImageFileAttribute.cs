using System.ComponentModel.DataAnnotations;

namespace Shop.Api.Common.Storage;

/// <summary>
/// Validates an uploaded image: size, extension, and the first bytes of the file.
/// A failed check becomes a normal 422 with an "errors" entry for the field.
/// </summary>
[AttributeUsage(AttributeTargets.Property | AttributeTargets.Parameter)]
public sealed class ImageFileAttribute : ValidationAttribute
{
    public const int MaxBytes = 5 * 1024 * 1024; // 5 MB

    // The file name and the Content-Type header are chosen by the client, so they can lie.
    // The first bytes ("magic numbers") show what the file really is.
    private static readonly Dictionary<string, byte[][]> Signatures = new()
    {
        [".jpg"] = [[0xFF, 0xD8, 0xFF]],
        [".jpeg"] = [[0xFF, 0xD8, 0xFF]],
        [".png"] = [[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]],
        [".webp"] = [[0x52, 0x49, 0x46, 0x46]], // "RIFF", followed by "WEBP" at byte 8 (checked below)
    };

    protected override ValidationResult? IsValid(object? value, ValidationContext context)
    {
        if (value is null)
            return ValidationResult.Success; // [Required] reports a missing file

        if (value is not IFormFile file)
            return new ValidationResult("The value must be a file.");

        if (file.Length == 0)
            return new ValidationResult("The image is empty.");

        if (file.Length > MaxBytes)
            return new ValidationResult($"The image must be at most {MaxBytes / 1024 / 1024} MB.");

        var extension = Path.GetExtension(file.FileName).ToLowerInvariant();
        if (!Signatures.TryGetValue(extension, out var signatures))
            return new ValidationResult("Only .jpg, .jpeg, .png and .webp images are allowed.");

        if (!HasValidSignature(file, extension, signatures))
            return new ValidationResult("The file content is not a valid image of its type.");

        return ValidationResult.Success;
    }

    private static bool HasValidSignature(IFormFile file, string extension, byte[][] signatures)
    {
        var header = new byte[12];
        using (var stream = file.OpenReadStream())
        {
            var read = stream.ReadAtLeast(header, header.Length, throwOnEndOfStream: false);
            if (read < header.Length)
                Array.Resize(ref header, read);
        }

        var matches = signatures.Any(signature => header.AsSpan().StartsWith(signature));

        // WebP: "RIFF" + 4 bytes of size + "WEBP".
        if (matches && extension == ".webp")
            matches = header.Length >= 12 && header.AsSpan(8, 4).SequenceEqual("WEBP"u8);

        return matches;
    }

    /// <summary>The Content-Type we send back when the image is downloaded, decided by us, not by the client.</summary>
    public static string ContentTypeFor(string extension) => extension switch
    {
        ".jpg" or ".jpeg" => "image/jpeg",
        ".png" => "image/png",
        ".webp" => "image/webp",
        _ => "application/octet-stream",
    };
}
